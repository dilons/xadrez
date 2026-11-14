// Conexão com a sala: WebSocket com reconexão automática (espera crescente), ping para medir a diferença
// entre o relógio do servidor e o do navegador, e reentrada com id e segredo depois de cair.
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';

export type Status = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionHandlers {
  /** Mensagem de entrada (`join`) a enviar a cada conexão: muda depois do primeiro welcome. */
  joinMessage(): ClientMessage;
  onMessage(m: ServerMessage): void;
  onStatus(s: Status): void;
}

/** Erros que não adianta tentar de novo. */
const FATAL = new Set(['room-not-found', 'removed', 'bad-identity', 'bad-nick', 'nick-taken', 'room-full']);

export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private stopped = false;
  private pingSentAt = 0;
  /** relógio do servidor − relógio local (ms), estimado pelo ping. */
  offset = 0;
  private bestRtt = Infinity;
  private h: ConnectionHandlers;

  constructor(h: ConnectionHandlers) {
    this.h = h;
  }

  /** Agora, no relógio do servidor. */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.h.onStatus('closed');
  }

  send(m: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...m }));
    return true;
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.h.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...this.h.joinMessage() }));
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 15_000);
    };
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        this.attempt = 0;
        this.syncClock(m.now, 0);
        this.h.onStatus('open');
      } else if (m.t === 'pong') {
        const rtt = Date.now() - this.pingSentAt;
        this.syncClock(m.now, rtt);
      } else if (m.t === 'error' && m.ref === 'join' && FATAL.has(m.code)) {
        this.stopped = true;
      } else if (m.t === 'kicked') {
        this.stopped = true;
      }
      this.h.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) {
        this.h.onStatus('closed');
        return;
      }
      this.attempt++;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt - 1, 5)) * (0.7 + Math.random() * 0.6);
      this.h.onStatus('reconnecting');
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };
  }

  private ping(): void {
    this.pingSentAt = Date.now();
    this.send({ t: 'ping' });
  }

  /** Usa a medida com menor ida-e-volta (a mais precisa). */
  private syncClock(serverNow: number, rtt: number): void {
    if (rtt > 0 && rtt > this.bestRtt * 1.5) return;
    if (rtt > 0) this.bestRtt = Math.min(this.bestRtt, rtt);
    this.offset = serverNow + rtt / 2 - Date.now();
  }

  /** Reconecta já (por exemplo, quando a aba volta a ficar visível). */
  nudge(): void {
    if (this.stopped || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    clearTimeout(this.retryTimer);
    this.open();
  }
}

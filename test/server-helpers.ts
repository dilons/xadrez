// Servidor de verdade (HTTP + WebSocket + SQLite num arquivo temporário) para os testes de integração.
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../shared/protocol.ts';
import { createApp, type App } from '../server/app.ts';
import type { Config } from '../server/config.ts';

export function testConfig(dir: string, over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: join(dir, 'xadrez.db'),
    webDir: join(dir, 'web'),
    publicUrl: 'https://xadrez.test',
    allowedOrigins: [],
    trustProxy: false,
    cfTrustedPeers: [],
    roomTtlMs: 7 * 86_400_000,
    graceMs: 60_000,
    maxPlayersPerRoom: 10,
    maxTablesPerRoom: 5,
    roomsPerIpPerHour: 5,
    connectionsPerIp: 8,
    messagesPerSecond: 50,
    messageBurst: 100,
    maxMessageBytes: 4096,
    maxRooms: 100,
    ...over,
  };
}

export interface Running {
  app: App;
  url: string;
  origin: string;
  dir: string;
  cfg: Config;
  stop(keepDir?: boolean): Promise<void>;
}

export async function startServer(over: Partial<Config> = {}, dir = mkdtempSync(join(tmpdir(), 'xadrez-'))): Promise<Running> {
  const cfg = testConfig(dir, over);
  const app = createApp(cfg);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    app,
    url: origin,
    origin,
    dir,
    cfg,
    async stop(keepDir = false) {
      await app.close();
      if (!keepDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createRoom(s: Running): Promise<{ code: string; creatorKey: string }> {
  const r = await fetch(`${s.url}/api/rooms`, { method: 'POST', headers: { origin: s.origin } });
  if (r.status !== 201) throw new Error(`POST /api/rooms: ${r.status}`);
  return (await r.json()) as { code: string; creatorKey: string };
}

/** Cliente WebSocket com fila: `next('welcome')` espera a próxima mensagem daquele tipo. */
export class Client {
  ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: { t: string; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;

  constructor(s: Running, headers: Record<string, string> = { origin: s.origin }) {
    this.ws = new WebSocket(`${s.url.replace('http', 'ws')}/ws`, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMessage & { v: number };
      const i = this.waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w!.timer);
        w!.resolve(m);
      } else this.queue.push(m);
    });
  }

  send(m: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...m }));
  }

  next<T extends ServerMessage['t']>(t: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const i = this.queue.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sem mensagem ${t} em ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({ t, resolve: resolve as (m: ServerMessage) => void, reject, timer });
    });
  }

  /** Descarta o que chegou até agora. */
  drain(): void {
    this.queue = [];
  }

  close(): Promise<{ code: number; reason: string }> {
    this.ws.close();
    return this.closed;
  }
}

export async function joinAs(s: Running, room: string, nick: string, creatorKey?: string) {
  const c = new Client(s);
  await c.opened;
  c.send({ t: 'join', room, nick, ...(creatorKey ? { creatorKey } : {}) });
  const w = await c.next('welcome');
  return { c, w, id: w.me.id, secret: w.me.secret! };
}

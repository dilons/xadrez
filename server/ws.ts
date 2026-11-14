// WebSocket (biblioteca ws) em /ws: confere a Origin, limita conexões por IP e o tamanho das mensagens,
// e mantém as conexões vivas com ping. O resto é com o hub.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.ts';
import { envelope, type Hub } from './hub.ts';
import { clientIp } from './ip.ts';

/** A Origin do navegador precisa ser a do próprio site (ou uma das ALLOWED_ORIGINS). */
export function originAllowed(req: IncomingMessage, cfg: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (cfg.allowedOrigins.length > 0) return cfg.allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachWebSocket(server: Server, hub: Hub, cfg: Config): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxMessageBytes, perMessageDeflate: false });
  const perIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  const reject = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return reject(socket, 404, 'Not Found');
    if (!originAllowed(req, cfg)) return reject(socket, 403, 'Forbidden');
    const ip = clientIp(req, cfg);
    const count = perIp.get(ip) ?? 0;
    if (count >= cfg.connectionsPerIp) return reject(socket, 429, 'Too Many Requests');
    perIp.set(ip, count + 1);
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      const conn = hub.newConn(
        ip,
        (msg) => {
          if (ws.readyState === ws.OPEN) ws.send(envelope(msg));
        },
        (code, reason) => ws.close(code, reason),
      );
      // Quem não entrar numa sala em 15 s é desconectado.
      const joinTimer = setTimeout(() => {
        if (!conn.room) ws.close(4000, 'sem entrar na sala');
      }, 15_000);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return ws.close(1003, 'só texto');
        hub.handle(conn, data.toString());
      });
      ws.on('close', () => {
        clearTimeout(joinTimer);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip);
        else perIp.set(ip, n);
        hub.detach(conn);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  // Conexões mortas (celular que perdeu o sinal) caem em até 60 s e liberam a presença.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1012, 'servidor reiniciando');
      wss.close();
    },
  };
}

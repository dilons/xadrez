// Monta o servidor (HTTP + WebSocket + hub + banco) sem escutar porta: usado pelo main.ts e pelos testes.
import { createServer, type Server } from 'node:http';
import type { Config } from './config.ts';
import { createHandler } from './http.ts';
import { Hub } from './hub.ts';
import { Store } from './store.ts';
import { attachWebSocket } from './ws.ts';

export interface App {
  server: Server;
  hub: Hub;
  store: Store;
  restored: number;
  close(): Promise<void>;
}

export function createApp(cfg: Config, now: () => number = Date.now): App {
  const store = new Store(cfg.dbPath);
  const hub = new Hub(cfg, store, now);
  const restored = hub.load();
  hub.startSweeper();
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, createHandler(hub, cfg));
  const ws = attachWebSocket(server, hub, cfg);
  return {
    server,
    hub,
    store,
    restored,
    close: () =>
      new Promise<void>((resolve) => {
        ws.close();
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}

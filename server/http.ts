// HTTP (node:http): a API pequena e os arquivos do front já gerados pelo Vite.
//   POST /api/rooms            cria uma sala → { code, creatorKey }
//   GET  /api/games/<id>       partida terminada (JSON, com o PGN)
//   GET  /api/games/<id>/pgn   o PGN para baixar
//   GET  /healthz              saúde
// O resto é o front: arquivos de web/dist, e index.html para as rotas da SPA (/, /s/<código>, /p/<id>, /bot).
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Config } from './config.ts';
import type { Hub } from './hub.ts';
import { clientIp } from './ip.ts';
import { originAllowed } from './ws.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const GAME_ID = /^[A-Za-z0-9]{6,16}$/;
const SPA_ROUTES = /^\/(?:s\/[a-z0-9]{6,16}|p\/[A-Za-z0-9]{6,16}|bot)?\/?$/;

function securityHeaders(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host ?? '';
  // connect-src com ws/wss explícitos: o 'self' não cobre WebSocket em todos os navegadores.
  const csp = [
    "default-src 'self'",
    // wasm-unsafe-eval: o Stockfish (WebAssembly) no Web Worker do bot.
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src 'self' ws://${host} wss://${host}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // O link da sala é o convite: não vaza para outros sites pelo Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

export function createHandler(hub: Hub, cfg: Config) {
  const webRoot = resolve(cfg.webDir);

  function serveFile(req: IncomingMessage, res: ServerResponse, rel: string, cache: string): boolean {
    const file = normalize(join(webRoot, rel));
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return false;
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) return false;
      size = st.size;
    } catch {
      return false;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': cache,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  }

  return function handler(req: IncomingMessage, res: ServerResponse): void {
    securityHeaders(req, res);
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return json(res, 400, { error: 'URL inválida' });
    }
    const method = req.method ?? 'GET';

    if (path === '/healthz') {
      return json(res, 200, { ok: true, rooms: hub.rooms.size, connections: hub.connectionCount });
    }

    if (path === '/api/rooms') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { error: 'Use POST.' });
      }
      // Só o próprio site cria salas (o navegador sempre manda Origin num POST com fetch).
      if (!originAllowed(req, cfg)) return json(res, 403, { error: 'Origem não permitida.' });
      req.resume();
      const r = hub.createRoom(clientIp(req, cfg));
      if ('error' in r) {
        if (r.error === 'rate-limited') res.setHeader('Retry-After', '600');
        return json(res, r.error === 'rate-limited' ? 429 : 503, {
          error: r.error === 'rate-limited' ? 'Muitas salas criadas daqui. Tente mais tarde.' : 'Servidor cheio. Tente mais tarde.',
        });
      }
      return json(res, 201, r);
    }

    const g = /^\/api\/games\/([^/]+)(\/pgn)?$/.exec(path);
    if (g) {
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, { error: 'Use GET.' });
      }
      const id = g[1]!;
      const game = GAME_ID.test(id) ? hub.store.getGame(id) : null;
      if (!game) return json(res, 404, { error: 'Partida não encontrada.' });
      if (g[2]) {
        const body = game.pgn + '\n';
        res.writeHead(200, {
          'Content-Type': 'application/x-chess-pgn; charset=utf-8',
          'Content-Disposition': `attachment; filename="xadrez-${game.id}.pgn"`,
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'public, max-age=86400',
        });
        return void res.end(method === 'HEAD' ? undefined : body);
      }
      const { room: _room, ...pub } = game;
      return json(res, 200, pub);
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'Não encontrado.' });

    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return json(res, 405, { error: 'Método não permitido.' });
    }
    if (SPA_ROUTES.test(path)) {
      if (serveFile(req, res, 'index.html', 'no-cache')) return;
      return json(res, 503, { error: 'Front não gerado: rode npm run build.' });
    }
    // Arquivos com hash no nome (assets/) nunca mudam; o resto revalida.
    const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    if (path !== '/' && serveFile(req, res, path.slice(1), cache)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado.');
  };
}

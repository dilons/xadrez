// Configuração por variáveis de ambiente. Todos os prazos e limites têm padrão; nada é obrigatório.
import { parseRanges, type CidrRange } from './ip.ts';

function int(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} inválido: ${raw}`);
  return Math.floor(n);
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** Pasta do front já gerado (vite build). */
  webDir: string;
  /** URL pública (para o campo Site do PGN). Vazio: "xadrez". */
  publicUrl: string;
  /** Origens aceitas no WebSocket. Vazio: só a do próprio Host. */
  allowedOrigins: string[];
  /** Atrás de proxy: o IP do cliente vem do último item de X-Forwarded-For. */
  trustProxy: boolean;
  /** Com trustProxy: se o último salto estiver nestas faixas (o conector da Cloudflare), vale o CF-Connecting-IP. */
  cfTrustedPeers: CidrRange[];
  roomTtlMs: number;
  graceMs: number;
  maxPlayersPerRoom: number;
  maxTablesPerRoom: number;
  roomsPerIpPerHour: number;
  connectionsPerIp: number;
  messagesPerSecond: number;
  messageBurst: number;
  maxMessageBytes: number;
  maxRooms: number;
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    dbPath: process.env.DB_PATH ?? './data/xadrez.db',
    webDir: process.env.WEB_DIR ?? './web/dist',
    publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    allowedOrigins: list('ALLOWED_ORIGINS'),
    trustProxy: process.env.TRUST_PROXY === '1',
    cfTrustedPeers: parseRanges(process.env.CF_TRUSTED_PEERS ?? ''),
    roomTtlMs: int('ROOM_TTL_DAYS', 7, 1) * 86_400_000,
    graceMs: int('DISCONNECT_GRACE_SECONDS', 60, 5) * 1000,
    maxPlayersPerRoom: int('MAX_PLAYERS_PER_ROOM', 50, 2),
    maxTablesPerRoom: int('MAX_TABLES_PER_ROOM', 20, 1),
    roomsPerIpPerHour: int('ROOMS_PER_IP_PER_HOUR', 20, 1),
    connectionsPerIp: int('CONNECTIONS_PER_IP', 20, 1),
    messagesPerSecond: int('MESSAGES_PER_SECOND', 10, 1),
    messageBurst: int('MESSAGE_BURST', 30, 1),
    maxMessageBytes: int('MAX_MESSAGE_BYTES', 4096, 256),
    maxRooms: int('MAX_ROOMS', 5000, 1),
  };
}

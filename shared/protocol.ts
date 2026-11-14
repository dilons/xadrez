// Protocolo entre o navegador e o servidor (WebSocket, JSON).
// Toda mensagem tem `v` (versão do protocolo) e `t` (tipo). Ao entrar, o cliente recebe a sala inteira (`welcome`);
// depois disso, só eventos. Este arquivo só tem tipos e constantes: é importado pelo servidor e pelo front.

export const PROTOCOL_VERSION = 1;

export type Color = 'w' | 'b';
export type ColorChoice = 'white' | 'black' | 'random';
export type Result = '1-0' | '0-1' | '1/2-1/2';
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'fifty-moves'
  | 'insufficient'
  | 'timeout'
  | 'timeout-vs-insufficient'
  | 'resign'
  | 'agreement'
  | 'abandon'
  | 'removed';

/** Controle de tempo: base e incremento em milissegundos. `null` é "sem tempo". */
export interface TimeControl {
  baseMs: number;
  incMs: number;
}

export const TIME_PRESETS: { label: string; tc: TimeControl | null }[] = [
  { label: '1+0', tc: { baseMs: 60_000, incMs: 0 } },
  { label: '3+2', tc: { baseMs: 180_000, incMs: 2_000 } },
  { label: '5+0', tc: { baseMs: 300_000, incMs: 0 } },
  { label: '10+0', tc: { baseMs: 600_000, incMs: 0 } },
  { label: '15+10', tc: { baseMs: 900_000, incMs: 10_000 } },
  { label: 'Sem tempo', tc: null },
];

export const LIMITS = {
  nickMin: 1,
  nickMax: 20,
  chatMax: 300,
  /** Tempo personalizado: base de 15 s a 3 h, incremento de 0 a 3 min. */
  baseMinMs: 15_000,
  baseMaxMs: 3 * 3600_000,
  incMaxMs: 180_000,
} as const;

export const REACTIONS = ['👍', '👏', '😮', '😂', '😅', '🔥', '🤝', '♟️'] as const;
export type Reaction = (typeof REACTIONS)[number];

// ---------------------------------------------------------------- vistas (o que os clientes enxergam)

export interface PlayerView {
  id: string;
  nick: string;
  online: boolean;
  creator: boolean;
}

export interface ClockView {
  whiteMs: number;
  blackMs: number;
  /** Cor cujo relógio está correndo (null: parado, por exemplo antes do 1º lance). */
  running: Color | null;
}

export interface GameView {
  /** Também é o id do link permanente /p/<id> quando a partida termina. */
  id: string;
  white: string;
  black: string;
  whiteNick: string;
  blackNick: string;
  tc: TimeControl | null;
  /** Lances em UCI (e2e4, e7e8q). O número de lances é o `seq` atual. */
  moves: string[];
  sans: string[];
  fen: string;
  clock: ClockView | null;
  drawOffer: Color | null;
  takebackRequest: Color | null;
  /** Desde quando (relógio do servidor, ms) cada jogador está desconectado. */
  awaySince: { w: number | null; b: number | null };
  result: Result | null;
  reason: EndReason | null;
  startedAt: number;
}

export type TableStatus = 'open' | 'playing' | 'finished';

export interface TableView {
  id: string;
  owner: string;
  tc: TimeControl | null;
  color: ColorChoice;
  /** Desafio para uma pessoa específica: só ela pode sentar. */
  challenged: string | null;
  status: TableStatus;
  game: GameView | null;
  /** Quem já pediu revanche (ids). */
  rematch: string[];
  createdAt: number;
}

export interface FinishedView {
  id: string;
  whiteNick: string;
  blackNick: string;
  result: Result;
  reason: EndReason;
  plies: number;
  tc: TimeControl | null;
  endedAt: number;
}

export interface ChatMessage {
  /** 'room' ou o id da mesa. */
  channel: string;
  from: string;
  nick: string;
  text: string;
  at: number;
}

export interface RoomView {
  code: string;
  /** Tolerância de desconexão (ms) antes de o adversário poder reivindicar a vitória. */
  graceMs: number;
  creator: string | null;
  players: PlayerView[];
  tables: TableView[];
  finished: FinishedView[];
  chat: ChatMessage[];
}

// ---------------------------------------------------------------- cliente → servidor

export type ClientMessage =
  | { t: 'join'; room: string; nick?: string; id?: string; secret?: string; creatorKey?: string }
  | { t: 'ping' }
  | { t: 'kick'; player: string }
  | { t: 'table.open'; tc: TimeControl | null; color: ColorChoice; challenged?: string }
  | { t: 'table.sit'; table: string }
  | { t: 'table.leave'; table: string }
  | { t: 'move'; table: string; seq: number; uci: string }
  | { t: 'abort'; table: string }
  | { t: 'resign'; table: string }
  | { t: 'draw'; table: string; action: 'offer' | 'accept' | 'decline' }
  | { t: 'takeback'; table: string; action: 'request' | 'accept' | 'decline' }
  | { t: 'claim'; table: string }
  | { t: 'rematch'; table: string }
  | { t: 'chat'; channel: string; text: string }
  | { t: 'react'; channel: string; emoji: string };

export type ClientMessageType = ClientMessage['t'];

// ---------------------------------------------------------------- servidor → cliente

export type ServerMessage =
  | { t: 'welcome'; me: { id: string; nick: string; secret?: string }; room: RoomView; now: number }
  | { t: 'error'; code: ErrorCode; message: string; ref?: string }
  | { t: 'pong'; now: number }
  | { t: 'player'; player: PlayerView }
  | { t: 'player.removed'; id: string }
  | { t: 'kicked' }
  | { t: 'table'; table: TableView; now: number }
  | { t: 'table.closed'; id: string }
  | { t: 'move'; table: string; seq: number; uci: string; san: string; fen: string; clock: ClockView | null; now: number }
  | { t: 'finished'; game: FinishedView }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'react'; channel: string; from: string; emoji: string };

export type ErrorCode =
  | 'bad-message'
  | 'rate-limited'
  | 'not-joined'
  | 'room-not-found'
  | 'room-full'
  | 'bad-nick'
  | 'nick-taken'
  | 'bad-identity'
  | 'removed'
  | 'forbidden'
  | 'table-not-found'
  | 'table-limit'
  | 'busy'
  | 'not-your-turn'
  | 'stale-move'
  | 'illegal-move'
  | 'game-over'
  | 'not-allowed';

/** Envolve uma mensagem com a versão do protocolo. */
export type Envelope<M> = M & { v: number };

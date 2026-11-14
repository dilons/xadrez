// Partida, pura: regras pelo chess.js, relógio de ./clock.ts, tempo sempre por parâmetro.
// O servidor é a autoridade: todo lance passa por applyMove, que confere vez, número de sequência e legalidade.
import { Chess } from 'chess.js';
import type { Color, EndReason, ErrorCode, GameView, Result, TimeControl } from '../../shared/protocol.ts';
import * as clk from './clock.ts';
import type { Clock } from './clock.ts';

export interface Game {
  id: string;
  white: string;
  black: string;
  whiteNick: string;
  blackNick: string;
  tc: TimeControl | null;
  chess: Chess;
  moves: string[];
  sans: string[];
  clock: Clock | null;
  drawOffer: Color | null;
  takebackRequest: Color | null;
  awaySince: { w: number | null; b: number | null };
  result: Result | null;
  reason: EndReason | null;
  startedAt: number;
  endedAt: number | null;
}

/** O que mudou numa ação. `error` exclui o resto. */
export interface Outcome {
  error?: ErrorCode;
  /** Um lance foi jogado (para o evento `move`, mais leve que a mesa inteira). */
  moved?: { uci: string; san: string };
  /** O estado da partida mudou além do lance (oferta, volta, fim…): reenviar a mesa. */
  changed?: boolean;
  ended?: boolean;
  aborted?: boolean;
}

const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function createGame(o: {
  id: string;
  white: string;
  black: string;
  whiteNick: string;
  blackNick: string;
  tc: TimeControl | null;
  now: number;
}): Game {
  return {
    id: o.id,
    white: o.white,
    black: o.black,
    whiteNick: o.whiteNick,
    blackNick: o.blackNick,
    tc: o.tc,
    chess: new Chess(),
    moves: [],
    sans: [],
    clock: o.tc ? clk.createClock(o.tc) : null,
    drawOffer: null,
    takebackRequest: null,
    awaySince: { w: null, b: null },
    result: null,
    reason: null,
    startedAt: o.now,
    endedAt: null,
  };
}

export function colorOf(g: Game, player: string): Color | null {
  if (player === g.white) return 'w';
  if (player === g.black) return 'b';
  return null;
}

export function isOver(g: Game): boolean {
  return g.result !== null;
}

function winFor(c: Color): Result {
  return c === 'w' ? '1-0' : '0-1';
}

export function finish(g: Game, result: Result, reason: EndReason, now: number): void {
  if (g.result) return;
  g.result = result;
  g.reason = reason;
  g.endedAt = now;
  g.drawOffer = null;
  g.takebackRequest = null;
  if (g.clock) clk.stop(g.clock, now);
}

/**
 * Pode `color` dar mate com o material que tem, por alguma sequência de lances (mesmo com ajuda)?
 * Usado na derrota por tempo: se quem sobrou não pode dar mate, é empate (regra 6.9 da FIDE).
 * Aproximação conservadora, como a dos sites: só rei, ou rei e uma peça menor contra rei sozinho,
 * ou só bispos da mesma cor de casa contra rei sozinho, não dão mate.
 */
export function canMate(chess: Chess, color: Color): boolean {
  const mine: string[] = [];
  const theirs: string[] = [];
  const bishopSquareColors = new Set<string>();
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.type === 'k') continue;
      if (sq.color === color) {
        mine.push(sq.type);
        if (sq.type === 'b') bishopSquareColors.add(chess.squareColor(sq.square) ?? '');
      } else theirs.push(sq.type);
    }
  }
  if (mine.some((p) => p === 'p' || p === 'r' || p === 'q')) return true;
  if (mine.length === 0) return false;
  const opponentBare = theirs.length === 0;
  if (!opponentBare) return true; // com peças do adversário, há mate de ajuda possível
  if (mine.length === 1) return false; // rei e uma peça menor contra rei
  const onlyBishops = mine.every((p) => p === 'b');
  if (onlyBishops && bishopSquareColors.size === 1) return false;
  return true;
}

/** Confere se o relógio de quem está na vez estourou; se sim, encerra a partida. */
export function checkTimeout(g: Game, now: number): boolean {
  if (isOver(g) || !g.clock) return false;
  const loser = clk.flagged(g.clock, now);
  if (!loser) return false;
  clk.settleFlag(g.clock, loser);
  const winner = clk.other(loser);
  if (canMate(g.chess, winner)) finish(g, winFor(winner), 'timeout', now);
  else finish(g, '1/2-1/2', 'timeout-vs-insufficient', now);
  return true;
}

function endIfFinal(g: Game, now: number): void {
  const c = g.chess;
  if (c.isCheckmate()) finish(g, winFor(clk.other(c.turn() as Color)), 'checkmate', now);
  else if (c.isStalemate()) finish(g, '1/2-1/2', 'stalemate', now);
  else if (c.isInsufficientMaterial()) finish(g, '1/2-1/2', 'insufficient', now);
  else if (c.isThreefoldRepetition()) finish(g, '1/2-1/2', 'repetition', now);
  else if (c.isDrawByFiftyMoves()) finish(g, '1/2-1/2', 'fifty-moves', now);
}

/**
 * Joga um lance. `seq` é o número de lances que o cliente já viu (o índice do lance novo):
 * repetidos e fora de ordem são recusados com `stale-move`.
 */
export function applyMove(g: Game, player: string, seq: number, uci: string, now: number): Outcome {
  if (checkTimeout(g, now)) return { error: 'game-over', changed: true, ended: true };
  if (isOver(g)) return { error: 'game-over' };
  const color = colorOf(g, player);
  if (!color) return { error: 'forbidden' };
  if (seq !== g.moves.length) return { error: 'stale-move' };
  if (g.chess.turn() !== color) return { error: 'not-your-turn' };
  const m = UCI.exec(uci);
  if (!m) return { error: 'illegal-move' };
  const [, from, to, promo] = m;
  const legal = g.chess
    .moves({ verbose: true })
    .find((mv) => mv.from === from && mv.to === to && (mv.promotion ?? undefined) === (promo ?? undefined));
  if (!legal) return { error: 'illegal-move' };
  g.chess.move({ from: legal.from, to: legal.to, promotion: legal.promotion });
  g.moves.push(uci);
  g.sans.push(legal.san);
  let changed = false;
  if (g.takebackRequest) {
    g.takebackRequest = null;
    changed = true;
  }
  // A oferta de empate cai quando o adversário de quem ofereceu joga (é a recusa implícita).
  if (g.drawOffer && g.drawOffer !== color) {
    g.drawOffer = null;
    changed = true;
  }
  // Os relógios só começam depois do primeiro lance de cada cor (como no Lichess).
  if (g.clock) clk.press(g.clock, color, now, g.moves.length >= 2);
  endIfFinal(g, now);
  return { moved: { uci, san: legal.san }, changed: changed || isOver(g), ended: isOver(g) };
}

export function resign(g: Game, player: string, now: number): Outcome {
  if (checkTimeout(g, now)) return { error: 'game-over', changed: true, ended: true };
  const color = colorOf(g, player);
  if (!color) return { error: 'forbidden' };
  if (isOver(g)) return { error: 'game-over' };
  finish(g, winFor(clk.other(color)), 'resign', now);
  return { changed: true, ended: true };
}

/** Abortar só vale antes de cada lado ter jogado: a partida some, sem resultado nem registro. */
export function canAbort(g: Game): boolean {
  return !isOver(g) && g.moves.length < 2;
}

export function draw(g: Game, player: string, action: 'offer' | 'accept' | 'decline', now: number): Outcome {
  if (checkTimeout(g, now)) return { error: 'game-over', changed: true, ended: true };
  const color = colorOf(g, player);
  if (!color) return { error: 'forbidden' };
  if (isOver(g)) return { error: 'game-over' };
  const opp = clk.other(color);
  if (action === 'offer') {
    if (g.drawOffer === opp) {
      finish(g, '1/2-1/2', 'agreement', now);
      return { changed: true, ended: true };
    }
    if (g.drawOffer === color) return {};
    g.drawOffer = color;
    return { changed: true };
  }
  if (g.drawOffer !== opp) return { error: 'not-allowed' };
  if (action === 'accept') {
    finish(g, '1/2-1/2', 'agreement', now);
    return { changed: true, ended: true };
  }
  g.drawOffer = null;
  return { changed: true };
}

/** Quantos lances voltam se `color` pedir: o último dele (e a resposta do adversário, se já veio). */
function takebackPlies(g: Game, color: Color): number {
  const n = g.moves.length;
  if (n === 0) return 0;
  const lastMover: Color = n % 2 === 1 ? 'w' : 'b';
  if (lastMover === color) return 1;
  return n >= 2 ? 2 : 0;
}

export function takeback(g: Game, player: string, action: 'request' | 'accept' | 'decline', now: number): Outcome {
  if (checkTimeout(g, now)) return { error: 'game-over', changed: true, ended: true };
  const color = colorOf(g, player);
  if (!color) return { error: 'forbidden' };
  if (isOver(g)) return { error: 'game-over' };
  const opp = clk.other(color);
  if (action === 'request') {
    if (takebackPlies(g, color) === 0) return { error: 'not-allowed' };
    if (g.takebackRequest === color) return {};
    g.takebackRequest = color;
    return { changed: true };
  }
  if (g.takebackRequest !== opp) return { error: 'not-allowed' };
  g.takebackRequest = null;
  if (action === 'decline') return { changed: true };
  const plies = takebackPlies(g, opp);
  for (let i = 0; i < plies; i++) {
    g.chess.undo();
    g.moves.pop();
    g.sans.pop();
  }
  g.drawOffer = null;
  // Ninguém recebe tempo de volta; o relógio passa a correr para quem está na vez (se já passou da abertura).
  if (g.clock) {
    clk.stop(g.clock, now);
    if (g.moves.length >= 2) clk.start(g.clock, g.chess.turn() as Color, now);
  }
  return { changed: true };
}

export function setAway(g: Game, player: string, since: number | null): boolean {
  const color = colorOf(g, player);
  if (!color || isOver(g)) return false;
  if (g.awaySince[color] === since) return false;
  g.awaySince[color] = since;
  return true;
}

/** O adversário sumiu há mais de `graceMs`: quem ficou pode reivindicar a vitória. */
export function claimVictory(g: Game, player: string, now: number, graceMs: number): Outcome {
  if (checkTimeout(g, now)) return { error: 'game-over', changed: true, ended: true };
  const color = colorOf(g, player);
  if (!color) return { error: 'forbidden' };
  if (isOver(g)) return { error: 'game-over' };
  const away = g.awaySince[clk.other(color)];
  if (away === null || now - away < graceMs) return { error: 'not-allowed' };
  finish(g, winFor(color), 'abandon', now);
  return { changed: true, ended: true };
}

/** Quem foi removido da sala perde as partidas em andamento. */
export function forfeit(g: Game, player: string, now: number): boolean {
  const color = colorOf(g, player);
  if (!color || isOver(g)) return false;
  finish(g, winFor(clk.other(color)), 'removed', now);
  return true;
}

export function view(g: Game, now: number): GameView {
  return {
    id: g.id,
    white: g.white,
    black: g.black,
    whiteNick: g.whiteNick,
    blackNick: g.blackNick,
    tc: g.tc,
    moves: [...g.moves],
    sans: [...g.sans],
    fen: g.chess.fen(),
    clock: g.clock ? clk.view(g.clock, now) : null,
    drawOffer: g.drawOffer,
    takebackRequest: g.takebackRequest,
    awaySince: { ...g.awaySince },
    result: g.result,
    reason: g.reason,
    startedAt: g.startedAt,
  };
}

// ---------------------------------------------------------------- persistência

export interface GameSnapshot {
  id: string;
  white: string;
  black: string;
  whiteNick: string;
  blackNick: string;
  tc: TimeControl | null;
  moves: string[];
  clock: Clock | null;
  drawOffer: Color | null;
  takebackRequest: Color | null;
  awaySince: { w: number | null; b: number | null };
  result: Result | null;
  reason: EndReason | null;
  startedAt: number;
  endedAt: number | null;
}

export function snapshot(g: Game): GameSnapshot {
  return {
    id: g.id,
    white: g.white,
    black: g.black,
    whiteNick: g.whiteNick,
    blackNick: g.blackNick,
    tc: g.tc,
    moves: [...g.moves],
    clock: g.clock ? structuredClone(g.clock) : null,
    drawOffer: g.drawOffer,
    takebackRequest: g.takebackRequest,
    awaySince: { ...g.awaySince },
    result: g.result,
    reason: g.reason,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
  };
}

/** Reconstrói a partida refazendo os lances (a posição, as repetições e a regra dos 50 vêm junto). */
export function restore(s: GameSnapshot): Game {
  const chess = new Chess();
  const sans: string[] = [];
  for (const uci of s.moves) {
    const m = UCI.exec(uci);
    if (!m) throw new Error(`lance inválido no snapshot: ${uci}`);
    sans.push(chess.move({ from: m[1]!, to: m[2]!, promotion: m[3] }).san);
  }
  return {
    ...s,
    chess,
    moves: [...s.moves],
    sans,
    clock: s.clock ? structuredClone(s.clock) : null,
    awaySince: { ...s.awaySince },
  };
}

// ---------------------------------------------------------------- PGN

const REASON_TEXT: Record<EndReason, string> = {
  checkmate: 'Xeque-mate',
  stalemate: 'Afogamento',
  repetition: 'Tripla repetição',
  'fifty-moves': 'Regra dos 50 lances',
  insufficient: 'Material insuficiente',
  timeout: 'Tempo esgotado',
  'timeout-vs-insufficient': 'Tempo esgotado, sem material para mate',
  resign: 'Desistência',
  agreement: 'Empate de comum acordo',
  abandon: 'Abandono',
  removed: 'Jogador removido da sala',
};

export function reasonText(r: EndReason): string {
  return REASON_TEXT[r];
}

function pgnDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
}

export function toPgn(g: Game, site: string): string {
  const c = new Chess();
  for (const uci of g.moves) {
    const m = UCI.exec(uci)!;
    c.move({ from: m[1]!, to: m[2]!, promotion: m[3] });
  }
  c.setHeader('Event', 'Partida amistosa');
  c.setHeader('Site', site);
  c.setHeader('Date', pgnDate(g.startedAt));
  c.setHeader('Round', '-');
  c.setHeader('White', g.whiteNick);
  c.setHeader('Black', g.blackNick);
  c.setHeader('Result', g.result ?? '*');
  c.setHeader('TimeControl', g.tc ? `${g.tc.baseMs / 1000}+${g.tc.incMs / 1000}` : '-');
  if (g.reason) c.setHeader('Termination', REASON_TEXT[g.reason]);
  return c.pgn();
}

// Validação das mensagens do cliente, sem biblioteca: formato, tipos e tamanhos. As regras do jogo ficam no domínio.
import { LIMITS, PROTOCOL_VERSION } from '../shared/protocol.ts';
import type { ClientMessage, ColorChoice, TimeControl } from '../shared/protocol.ts';

const ID = /^[A-Za-z0-9_-]{4,32}$/;
const ROOM = /^[a-z0-9]{6,16}$/;
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is string => typeof x === 'string' && ID.test(x);
const optStr = (x: unknown, max: number) => x === undefined || (typeof x === 'string' && x.length <= max);

export function validRoomCode(x: unknown): x is string {
  return typeof x === 'string' && ROOM.test(x);
}

export function parseTimeControl(x: unknown): TimeControl | null | undefined {
  if (x === null) return null;
  if (!isObj(x)) return undefined;
  const { baseMs, incMs } = x;
  if (!Number.isInteger(baseMs) || !Number.isInteger(incMs)) return undefined;
  const b = baseMs as number;
  const i = incMs as number;
  if (b < LIMITS.baseMinMs || b > LIMITS.baseMaxMs || i < 0 || i > LIMITS.incMaxMs) return undefined;
  if (b % 1000 !== 0 || i % 1000 !== 0) return undefined;
  return { baseMs: b, incMs: i };
}

const COLORS: ColorChoice[] = ['white', 'black', 'random'];

/** Devolve a mensagem tipada, ou null se for inválida. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || m.v !== PROTOCOL_VERSION || typeof m.t !== 'string') return null;
  const table = m.table;
  switch (m.t) {
    case 'join':
      if (!validRoomCode(m.room)) return null;
      if (!optStr(m.nick, 200) || !optStr(m.creatorKey, 100)) return null;
      if (m.id !== undefined && !isId(m.id)) return null;
      if (!optStr(m.secret, 100)) return null;
      return {
        t: 'join',
        room: m.room,
        nick: m.nick as string | undefined,
        id: m.id as string | undefined,
        secret: m.secret as string | undefined,
        creatorKey: m.creatorKey as string | undefined,
      };
    case 'ping':
      return { t: 'ping' };
    case 'kick':
      return isId(m.player) ? { t: 'kick', player: m.player } : null;
    case 'table.open': {
      const tc = parseTimeControl(m.tc);
      if (tc === undefined || !COLORS.includes(m.color as ColorChoice)) return null;
      if (m.challenged !== undefined && !isId(m.challenged)) return null;
      return {
        t: 'table.open',
        tc,
        color: m.color as ColorChoice,
        ...(m.challenged !== undefined ? { challenged: m.challenged as string } : {}),
      };
    }
    case 'table.sit':
    case 'table.leave':
    case 'abort':
    case 'resign':
    case 'claim':
    case 'rematch':
      return isId(table) ? ({ t: m.t, table } as ClientMessage) : null;
    case 'move':
      if (!isId(table) || !Number.isInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > 10_000) return null;
      if (typeof m.uci !== 'string' || !UCI.test(m.uci)) return null;
      return { t: 'move', table, seq: m.seq as number, uci: m.uci };
    case 'draw':
      if (!isId(table) || !['offer', 'accept', 'decline'].includes(m.action as string)) return null;
      return { t: 'draw', table, action: m.action as 'offer' | 'accept' | 'decline' };
    case 'takeback':
      if (!isId(table) || !['request', 'accept', 'decline'].includes(m.action as string)) return null;
      return { t: 'takeback', table, action: m.action as 'request' | 'accept' | 'decline' };
    case 'chat':
      if (!(m.channel === 'room' || isId(m.channel)) || typeof m.text !== 'string' || m.text.length > LIMITS.chatMax * 4)
        return null;
      return { t: 'chat', channel: m.channel as string, text: m.text };
    case 'react':
      if (!(m.channel === 'room' || isId(m.channel)) || typeof m.emoji !== 'string' || m.emoji.length > 16) return null;
      return { t: 'react', channel: m.channel as string, emoji: m.emoji };
    default:
      return null;
  }
}

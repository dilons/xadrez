// Ajudantes dos testes: relógio controlado, ids previsíveis e uma gravação em memória.
import { createHash } from 'node:crypto';
import type { ServerMessage } from '../shared/protocol.ts';
import type { FinishedRecord, Out, Player, RoomDeps, RoomRecord, RoomStore, TableSnapshot } from '../server/domain/room.ts';
import { Room } from '../server/domain/room.ts';

export class FakeClock {
  t = 1_700_000_000_000;
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export class MemoryStore implements RoomStore {
  rooms = new Map<string, RoomRecord>();
  players = new Map<string, Player>();
  tables = new Map<string, TableSnapshot>();
  finished: FinishedRecord[] = [];
  saveRoom(r: RoomRecord): void {
    this.rooms.set(r.code, { ...r });
  }
  savePlayer(_code: string, p: Player): void {
    this.players.set(p.id, { ...p });
  }
  saveTable(_code: string, t: TableSnapshot): void {
    this.tables.set(t.id, structuredClone(t));
  }
  deleteTable(_code: string, id: string): void {
    this.tables.delete(id);
  }
  saveFinished(_code: string, f: FinishedRecord): void {
    this.finished.push(f);
  }
}

export function makeDeps(clock = new FakeClock(), store = new MemoryStore(), random = () => 0.1): RoomDeps {
  let n = 0;
  return {
    now: clock.now,
    id: (len) => `id${String(++n).padStart(Math.max(2, len - 2), '0')}`,
    secret: () => `segredo-${++n}`,
    hash: (s) => createHash('sha256').update(s).digest('hex'),
    sameHash: (a, b) => a === b,
    random,
    site: (id) => `https://xadrez.test/p/${id}`,
    store,
    limits: {
      maxPlayers: 5,
      maxTables: 4,
      graceMs: 60_000,
      chatBurst: 3,
      chatPerSecond: 0.5,
      reactBurst: 2,
      reactPerSecond: 1,
      keepFinished: 10,
      keepChat: 5,
    },
  };
}

/** Sala com `nicks` já dentro e conectados. Devolve os ids na mesma ordem. */
export function roomWith(nicks: string[], deps = makeDeps()) {
  const { room, creatorKey } = Room.create('abcdefghjk', deps);
  const ids: string[] = [];
  const secrets: string[] = [];
  nicks.forEach((nick, i) => {
    const r = room.join({ nick, creatorKey: i === 0 ? creatorKey : undefined });
    if ('error' in r) throw new Error(r.message);
    room.connect(r.player.id);
    ids.push(r.player.id);
    secrets.push(r.secret!);
  });
  return { room, ids, secrets, deps };
}

export function msgs(outs: Out[], t?: ServerMessage['t']): ServerMessage[] {
  return outs.map((o) => o.msg).filter((m) => !t || m.t === t);
}

export function errorCode(outs: Out[]): string | undefined {
  const e = outs.find((o) => o.msg.t === 'error');
  return e && e.msg.t === 'error' ? e.msg.code : undefined;
}

/** Joga uma sequência de lances UCI alternando os dois jogadores. */
export function play(room: Room, tableId: string, white: string, black: string, ucis: string[]): Out[] {
  const all: Out[] = [];
  for (const uci of ucis) {
    const t = room.tables.get(tableId)!;
    const g = t.game!;
    const who = g.chess.turn() === 'w' ? white : black;
    const outs = room.move(who, tableId, g.moves.length, uci);
    const e = errorCode(outs);
    if (e) throw new Error(`${uci}: ${e}`);
    all.push(...outs);
  }
  return all;
}

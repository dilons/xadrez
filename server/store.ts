// Persistência em SQLite (node:sqlite, embutido no Node 22.13+; síncrono, um arquivo num volume).
// Salas e partidas ao vivo ficam na memória; aqui vai um snapshot a cada mudança, para sobreviver a um restart,
// e as partidas terminadas, com o PGN do link permanente /p/<id>.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EndReason, FinishedView, Result, TimeControl } from '../shared/protocol.ts';
import type { FinishedRecord, Player, RoomRecord, RoomStore, TableSnapshot } from './domain/room.ts';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  creator TEXT,
  creator_key_hash TEXT,
  created_at INTEGER NOT NULL,
  active_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  id TEXT NOT NULL,
  nick TEXT NOT NULL,
  nick_key TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room, id)
);
CREATE TABLE IF NOT EXISTS tables (
  room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room, id)
);
-- Partidas terminadas: não dependem da sala (o link /p/<id> continua valendo depois que ela expira).
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  white TEXT NOT NULL,
  black TEXT NOT NULL,
  white_nick TEXT NOT NULL,
  black_nick TEXT NOT NULL,
  tc TEXT,
  result TEXT NOT NULL,
  reason TEXT NOT NULL,
  plies INTEGER NOT NULL,
  pgn TEXT NOT NULL,
  final_fen TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_room ON games(room, ended_at DESC);
`;

export interface StoredGame {
  id: string;
  room: string;
  whiteNick: string;
  blackNick: string;
  tc: TimeControl | null;
  result: Result;
  reason: EndReason;
  plies: number;
  pgn: string;
  finalFen: string;
  startedAt: number;
  endedAt: number;
}

export interface LoadedRoom {
  room: RoomRecord;
  players: Player[];
  tables: TableSnapshot[];
  finished: FinishedView[];
}

type Row = Record<string, unknown>;

export class Store implements RoomStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    this.db.exec(SCHEMA);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  saveRoom(r: RoomRecord): void {
    this.db
      .prepare(
        `INSERT INTO rooms (code, creator, creator_key_hash, created_at, active_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET creator = excluded.creator, creator_key_hash = excluded.creator_key_hash,
           active_at = excluded.active_at`,
      )
      .run(r.code, r.creator, r.creatorKeyHash, r.createdAt, r.activeAt);
  }

  savePlayer(code: string, p: Player): void {
    this.db
      .prepare(
        `INSERT INTO players (room, id, nick, nick_key, secret_hash, joined_at, removed) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room, id) DO UPDATE SET nick = excluded.nick, nick_key = excluded.nick_key, removed = excluded.removed`,
      )
      .run(code, p.id, p.nick, p.nickKey, p.secretHash, p.joinedAt, p.removed ? 1 : 0);
  }

  saveTable(code: string, t: TableSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO tables (room, id, snapshot, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(room, id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
      )
      .run(code, t.id, JSON.stringify(t), Date.now());
  }

  deleteTable(code: string, id: string): void {
    this.db.prepare('DELETE FROM tables WHERE room = ? AND id = ?').run(code, id);
  }

  saveFinished(code: string, f: FinishedRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO games (id, room, white, black, white_nick, black_nick, tc, result, reason, plies, pgn,
           final_fen, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.id,
        code,
        f.white,
        f.black,
        f.whiteNick,
        f.blackNick,
        f.tc ? JSON.stringify(f.tc) : null,
        f.result,
        f.reason,
        f.plies,
        f.pgn,
        f.finalFen,
        f.startedAt,
        f.endedAt,
      );
  }

  roomExists(code: string): boolean {
    return this.db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code) !== undefined;
  }

  deleteRoom(code: string): void {
    this.db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
  }

  loadRooms(keepFinished: number): LoadedRoom[] {
    const rooms = this.db.prepare('SELECT * FROM rooms').all() as Row[];
    return rooms.map((r) => {
      const code = String(r.code);
      const players = (this.db.prepare('SELECT * FROM players WHERE room = ?').all(code) as Row[]).map(
        (p): Player => ({
          id: String(p.id),
          nick: String(p.nick),
          nickKey: String(p.nick_key),
          secretHash: String(p.secret_hash),
          joinedAt: Number(p.joined_at),
          removed: Number(p.removed) === 1,
        }),
      );
      const tables = (this.db.prepare('SELECT snapshot FROM tables WHERE room = ?').all(code) as Row[]).map(
        (t) => JSON.parse(String(t.snapshot)) as TableSnapshot,
      );
      const finished = (
        this.db.prepare('SELECT * FROM games WHERE room = ? ORDER BY ended_at DESC LIMIT ?').all(code, keepFinished) as Row[]
      ).map((g) => finishedView(rowToGame(g)));
      return {
        room: {
          code,
          creator: r.creator === null ? null : String(r.creator),
          creatorKeyHash: r.creator_key_hash === null ? null : String(r.creator_key_hash),
          createdAt: Number(r.created_at),
          activeAt: Number(r.active_at),
        },
        players,
        tables,
        finished,
      };
    });
  }

  getGame(id: string): StoredGame | null {
    const g = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as Row | undefined;
    return g ? rowToGame(g) : null;
  }

  stats(): { rooms: number; games: number } {
    const rooms = Number((this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as Row).n);
    const games = Number((this.db.prepare('SELECT COUNT(*) AS n FROM games').get() as Row).n);
    return { rooms, games };
  }
}

function rowToGame(g: Row): StoredGame {
  return {
    id: String(g.id),
    room: String(g.room),
    whiteNick: String(g.white_nick),
    blackNick: String(g.black_nick),
    tc: g.tc === null ? null : (JSON.parse(String(g.tc)) as TimeControl),
    result: String(g.result) as Result,
    reason: String(g.reason) as EndReason,
    plies: Number(g.plies),
    pgn: String(g.pgn),
    finalFen: String(g.final_fen),
    startedAt: Number(g.started_at),
    endedAt: Number(g.ended_at),
  };
}

function finishedView(g: StoredGame): FinishedView {
  return {
    id: g.id,
    whiteNick: g.whiteNick,
    blackNick: g.blackNick,
    result: g.result,
    reason: g.reason,
    plies: g.plies,
    tc: g.tc,
    endedAt: g.endedAt,
  };
}

// Hub: liga as conexões WebSocket às salas. Valida cada mensagem, aplica o limite de taxa, chama o domínio
// (server/domain/room.ts) e entrega as mensagens que ele devolve. Também cuida dos relógios (um timer por sala)
// e da expiração das salas vazias.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import type { Config } from './config.ts';
import { Bucket, KeyedBuckets } from './domain/limits.ts';
import { Room } from './domain/room.ts';
import type { Out, RoomDeps, RoomLimits } from './domain/room.ts';
import type { Store } from './store.ts';
import { parseClientMessage } from './validate.ts';

/** Uma conexão, vista pelo hub (o ws.ts adapta o WebSocket a isto; os testes usam um falso). */
export interface Conn {
  ip: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
  room?: Room;
  player?: string;
  bucket: Bucket;
  strikes: number;
}

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(len: number, alphabet: string): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** Código da sala: 10 caracteres sem os ambíguos (0/o, 1/l/i), ~49 bits. */
export function newRoomCode(): string {
  return randomString(10, ROOM_ALPHABET);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const MAX_TIMER_MS = 2_147_000_000;
/** Erros seguidos (mensagens inválidas ou acima do limite) antes de derrubar a conexão. */
const MAX_STRIKES = 20;

export class Hub {
  readonly rooms = new Map<string, Room>();
  private conns = new Map<string, Set<Conn>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private roomCreation: KeyedBuckets;
  private sweeper: NodeJS.Timeout | null = null;
  private stopped = false;
  private cfg: Config;
  readonly store: Store;
  private now: () => number;
  private limits: RoomLimits;

  constructor(cfg: Config, store: Store, now: () => number = Date.now) {
    this.cfg = cfg;
    this.store = store;
    this.now = now;
    this.roomCreation = new KeyedBuckets(cfg.roomsPerIpPerHour, cfg.roomsPerIpPerHour / 3600);
    this.limits = {
      maxPlayers: cfg.maxPlayersPerRoom,
      maxTables: cfg.maxTablesPerRoom,
      graceMs: cfg.graceMs,
      chatBurst: 5,
      chatPerSecond: 0.5,
      reactBurst: 4,
      reactPerSecond: 1,
      keepFinished: 30,
      keepChat: 100,
    };
  }

  private deps(): RoomDeps {
    const site = this.cfg.publicUrl;
    return {
      now: this.now,
      id: (len) => randomString(len, ID_ALPHABET),
      secret: () => randomBytes(24).toString('base64url'),
      hash: sha256,
      sameHash,
      random: () => randomInt(1_000_000) / 1_000_000,
      site: (id) => (site ? `${site}/p/${id}` : 'xadrez'),
      store: this.store,
      limits: this.limits,
    };
  }

  /** Recarrega do banco as salas e as partidas em andamento. */
  load(): number {
    for (const l of this.store.loadRooms(this.limits.keepFinished)) {
      const room = Room.restore(l.room, l.players, l.tables, l.finished, this.deps());
      this.rooms.set(room.code, room);
      this.schedule(room);
    }
    return this.rooms.size;
  }

  startSweeper(everyMs = 10 * 60_000): void {
    this.sweeper = setInterval(() => this.sweep(), everyMs);
    this.sweeper.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const room of this.rooms.values()) room.persistActivity();
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this.conns.values()) n += s.size;
    return n;
  }

  // ------------------------------------------------------------ salas

  /** Cria uma sala (POST /api/rooms). Devolve null se o IP passou do limite ou o servidor está cheio. */
  createRoom(ip: string): { code: string; creatorKey: string } | { error: 'rate-limited' | 'full' } {
    if (this.rooms.size >= this.cfg.maxRooms) return { error: 'full' };
    if (!this.roomCreation.take(ip, this.now())) return { error: 'rate-limited' };
    let code = newRoomCode();
    while (this.rooms.has(code) || this.store.roomExists(code)) code = newRoomCode();
    const { room, creatorKey } = Room.create(code, this.deps());
    this.rooms.set(code, room);
    return { code, creatorKey };
  }

  /** Apaga as salas sem ninguém conectado há mais de ROOM_TTL_DAYS. As partidas terminadas (links /p/) ficam. */
  sweep(): string[] {
    const gone: string[] = [];
    for (const [code, room] of this.rooms) {
      if (!room.expired(this.cfg.roomTtlMs)) continue;
      const t = this.timers.get(code);
      if (t) clearTimeout(t);
      this.timers.delete(code);
      this.rooms.delete(code);
      this.conns.delete(code);
      this.store.deleteRoom(code);
      gone.push(code);
    }
    this.roomCreation.sweep(this.now());
    return gone;
  }

  // ------------------------------------------------------------ conexões

  newConn(ip: string, send: Conn['send'], close: Conn['close']): Conn {
    return { ip, send, close, bucket: new Bucket(this.cfg.messageBurst, this.cfg.messagesPerSecond, this.now()), strikes: 0 };
  }

  private strike(c: Conn, msg: ServerMessage): void {
    c.strikes++;
    if (c.strikes > MAX_STRIKES) c.close(4008, 'muitas mensagens inválidas');
    else c.send(msg);
  }

  handle(c: Conn, raw: string): void {
    if (!c.bucket.take(this.now())) {
      this.strike(c, { t: 'error', code: 'rate-limited', message: 'Devagar: muitas mensagens seguidas.' });
      return;
    }
    const m = parseClientMessage(raw);
    if (!m) {
      this.strike(c, { t: 'error', code: 'bad-message', message: 'Mensagem inválida.' });
      return;
    }
    if (m.t === 'ping') {
      c.send({ t: 'pong', now: this.now() });
      return;
    }
    if (!c.room || !c.player) {
      if (m.t !== 'join') {
        this.strike(c, { t: 'error', code: 'not-joined', message: 'Entre na sala primeiro.' });
        return;
      }
      this.join(c, m);
      return;
    }
    if (m.t === 'join') {
      this.strike(c, { t: 'error', code: 'bad-message', message: 'Você já está na sala.' });
      return;
    }
    c.strikes = 0;
    const room = c.room;
    room.touch();
    this.deliver(room, this.dispatch(room, c.player, m));
    this.schedule(room);
  }

  private join(c: Conn, m: Extract<ClientMessage, { t: 'join' }>): void {
    const room = this.rooms.get(m.room);
    if (!room) {
      c.send({ t: 'error', code: 'room-not-found', message: 'Essa sala não existe ou já expirou.', ref: 'join' });
      return;
    }
    const r = room.join(m);
    if ('error' in r) {
      c.send({ t: 'error', code: r.error, message: r.message, ref: 'join' });
      return;
    }
    c.room = room;
    c.player = r.player.id;
    const outs = room.connect(r.player.id);
    c.send({
      t: 'welcome',
      me: { id: r.player.id, nick: r.player.nick, ...(r.secret ? { secret: r.secret } : {}) },
      room: room.view(),
      now: this.now(),
    });
    let set = this.conns.get(room.code);
    if (!set) this.conns.set(room.code, (set = new Set()));
    set.add(c);
    // Quem acabou de entrar já recebeu tudo no welcome.
    this.deliver(room, outs, c);
  }

  private dispatch(room: Room, me: string, m: ClientMessage): Out[] {
    switch (m.t) {
      case 'kick':
        return room.kick(me, m.player);
      case 'table.open':
        return room.openTable(me, { tc: m.tc, color: m.color, challenged: m.challenged });
      case 'table.sit':
        return room.sit(me, m.table);
      case 'table.leave':
        return room.leave(me, m.table);
      case 'move':
        return room.move(me, m.table, m.seq, m.uci);
      case 'abort':
        return room.abort(me, m.table);
      case 'resign':
        return room.resign(me, m.table);
      case 'draw':
        return room.draw(me, m.table, m.action);
      case 'takeback':
        return room.takeback(me, m.table, m.action);
      case 'claim':
        return room.claim(me, m.table);
      case 'rematch':
        return room.rematch(me, m.table);
      case 'chat':
        return room.say(me, m.channel, m.text);
      case 'react':
        return room.react(me, m.channel, m.emoji);
      default:
        return [];
    }
  }

  detach(c: Conn): void {
    const room = c.room;
    if (this.stopped || !room || !c.player) return;
    this.conns.get(room.code)?.delete(c);
    const player = c.player;
    c.room = undefined;
    c.player = undefined;
    this.deliver(room, room.disconnect(player));
    if (room.onlineCount() === 0) room.persistActivity();
  }

  private deliver(room: Room, outs: Out[], except?: Conn): void {
    const set = this.conns.get(room.code);
    if (!set) return;
    for (const o of outs) {
      for (const c of set) {
        if (c === except || (o.to !== null && c.player !== o.to)) continue;
        c.send(o.msg);
        if (o.msg.t === 'kicked') c.close(4001, 'removido da sala');
      }
    }
  }

  // ------------------------------------------------------------ relógios

  private schedule(room: Room): void {
    const old = this.timers.get(room.code);
    if (old) clearTimeout(old);
    this.timers.delete(room.code);
    const ms = room.nextFlagIn();
    if (ms === null) return;
    const t = setTimeout(() => {
      this.timers.delete(room.code);
      this.deliver(room, room.tick());
      this.schedule(room);
    }, Math.min(ms + 5, MAX_TIMER_MS));
    t.unref();
    this.timers.set(room.code, t);
  }
}

export function envelope(msg: ServerMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
}

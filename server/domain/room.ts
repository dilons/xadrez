// Sala, pura: presença, mesas, partidas, chat e remoção. Sem rede e sem relógio próprio: o tempo, os sorteios,
// os ids e a gravação entram por `RoomDeps`. Cada ação devolve a lista de mensagens a enviar (`Out[]`);
// quem chama (server/hub.ts) só as entrega.
//
// Para um mini-torneio no futuro: ele seria um dono de várias mesas criadas pela sala (o mesmo openTable com
// `challenged` fixo) mais uma tabela de pontos alimentada por onGameEnded. Nada aqui depende de "mesa avulsa".
import type {
  ChatMessage,
  ColorChoice,
  ErrorCode,
  FinishedView,
  PlayerView,
  RoomView,
  ServerMessage,
  TableStatus,
  TableView,
  TimeControl,
} from '../../shared/protocol.ts';
import { REACTIONS } from '../../shared/protocol.ts';
import * as clk from './clock.ts';
import * as G from './game.ts';
import type { Game, GameSnapshot, Outcome } from './game.ts';
import { Bucket } from './limits.ts';
import { cleanChat, cleanNick, nickKey } from './text.ts';

// ---------------------------------------------------------------- tipos

export interface Player {
  id: string;
  nick: string;
  nickKey: string;
  secretHash: string;
  joinedAt: number;
  removed: boolean;
}

export interface Table {
  id: string;
  owner: string;
  tc: TimeControl | null;
  color: ColorChoice;
  challenged: string | null;
  status: TableStatus;
  game: Game | null;
  rematch: Set<string>;
  createdAt: number;
}

export interface RoomRecord {
  code: string;
  creator: string | null;
  creatorKeyHash: string | null;
  createdAt: number;
  activeAt: number;
}

export interface TableSnapshot {
  id: string;
  owner: string;
  tc: TimeControl | null;
  color: ColorChoice;
  challenged: string | null;
  status: TableStatus;
  game: GameSnapshot | null;
  rematch: string[];
  createdAt: number;
}

export interface FinishedRecord extends FinishedView {
  white: string;
  black: string;
  pgn: string;
  finalFen: string;
  startedAt: number;
}

/** Onde a sala grava o que precisa sobreviver a um restart (SQLite no servidor, memória nos testes). */
export interface RoomStore {
  saveRoom(r: RoomRecord): void;
  savePlayer(code: string, p: Player): void;
  saveTable(code: string, t: TableSnapshot): void;
  deleteTable(code: string, id: string): void;
  saveFinished(code: string, f: FinishedRecord): void;
}

export interface RoomLimits {
  maxPlayers: number;
  maxTables: number;
  /** Tolerância de desconexão antes de o adversário poder reivindicar a vitória. */
  graceMs: number;
  chatBurst: number;
  chatPerSecond: number;
  reactBurst: number;
  reactPerSecond: number;
  /** Quantas partidas terminadas e mensagens de chat (por canal) a sala guarda na memória. */
  keepFinished: number;
  keepChat: number;
}

export interface RoomDeps {
  now(): number;
  /** Id aleatório (alfabeto seguro para URL). */
  id(len: number): string;
  /** Segredo do jogador (vai só para ele) e o hash que fica guardado. */
  secret(): string;
  hash(s: string): string;
  /** Comparação em tempo constante de dois hashes. */
  sameHash(a: string, b: string): boolean;
  random(): number;
  site(gameId: string): string;
  store: RoomStore;
  limits: RoomLimits;
}

/** Destino: `null` é a sala inteira; uma string é um jogador. */
export interface Out {
  to: string | null;
  msg: ServerMessage;
}

export type JoinResult =
  | { error: ErrorCode; message: string }
  | { player: Player; secret?: string; outs: Out[] };

const ERR: Partial<Record<ErrorCode, string>> = {
  forbidden: 'Você não pode fazer isso.',
  'table-not-found': 'Essa mesa não existe mais.',
  'table-limit': 'A sala chegou ao limite de mesas.',
  busy: 'Você ou a outra pessoa já está numa partida.',
  'not-your-turn': 'Não é a sua vez.',
  'stale-move': 'Esse lance chegou fora de ordem.',
  'illegal-move': 'Lance ilegal.',
  'game-over': 'A partida já terminou.',
  'not-allowed': 'Isso não vale agora.',
  'rate-limited': 'Devagar: muitas mensagens seguidas.',
  'bad-message': 'Mensagem inválida.',
};

function err(to: string, code: ErrorCode, ref?: string, message?: string): Out {
  return { to, msg: { t: 'error', code, message: message ?? ERR[code] ?? code, ...(ref ? { ref } : {}) } };
}

// ---------------------------------------------------------------- sala

export class Room {
  readonly code: string;
  creator: string | null;
  private creatorKeyHash: string | null;
  readonly createdAt: number;
  activeAt: number;
  readonly players = new Map<string, Player>();
  readonly tables = new Map<string, Table>();
  finished: FinishedView[] = [];
  private chat = new Map<string, ChatMessage[]>();
  private connections = new Map<string, number>();
  private chatBuckets = new Map<string, Bucket>();
  private reactBuckets = new Map<string, Bucket>();
  private deps: RoomDeps;

  constructor(rec: RoomRecord, deps: RoomDeps) {
    this.code = rec.code;
    this.creator = rec.creator;
    this.creatorKeyHash = rec.creatorKeyHash;
    this.createdAt = rec.createdAt;
    this.activeAt = rec.activeAt;
    this.deps = deps;
  }

  /** Sala nova: devolve a sala e a chave de criador (uma vez só; quem entrar com ela vira o criador). */
  static create(code: string, deps: RoomDeps): { room: Room; creatorKey: string } {
    const creatorKey = deps.secret();
    const now = deps.now();
    const rec: RoomRecord = { code, creator: null, creatorKeyHash: deps.hash(creatorKey), createdAt: now, activeAt: now };
    deps.store.saveRoom(rec);
    return { room: new Room(rec, deps), creatorKey };
  }

  /** Reconstrói a sala do banco depois de um restart. */
  static restore(
    rec: RoomRecord,
    players: Player[],
    tables: TableSnapshot[],
    finished: FinishedView[],
    deps: RoomDeps,
  ): Room {
    const room = new Room(rec, deps);
    const now = deps.now();
    for (const p of players) room.players.set(p.id, p);
    for (const s of tables) {
      const game = s.game ? G.restore(s.game) : null;
      if (game && !G.isOver(game)) {
        if (game.clock) clk.resumeAfterDowntime(game.clock, now);
        // Ninguém está conectado logo depois do restart: conta a ausência a partir de agora.
        game.awaySince = { w: now, b: now };
      }
      room.tables.set(s.id, { ...s, game, rematch: new Set(s.rematch) });
    }
    room.finished = finished.slice(0, deps.limits.keepFinished);
    return room;
  }

  private record(): RoomRecord {
    return {
      code: this.code,
      creator: this.creator,
      creatorKeyHash: this.creatorKeyHash,
      createdAt: this.createdAt,
      activeAt: this.activeAt,
    };
  }

  touch(): void {
    this.activeAt = this.deps.now();
  }

  // ------------------------------------------------------------ presença

  isOnline(id: string): boolean {
    return (this.connections.get(id) ?? 0) > 0;
  }

  onlineCount(): number {
    let n = 0;
    for (const c of this.connections.values()) if (c > 0) n++;
    return n;
  }

  private activePlayers(): Player[] {
    return [...this.players.values()].filter((p) => !p.removed);
  }

  playerView(p: Player): PlayerView {
    return { id: p.id, nick: p.nick, online: this.isOnline(p.id), creator: p.id === this.creator };
  }

  /**
   * Entrada: com id e segredo (reconexão) ou com um apelido (pessoa nova).
   * Não conecta: depois de responder o `welcome`, quem chama faz `connect`.
   */
  join(o: { nick?: unknown; id?: unknown; secret?: unknown; creatorKey?: unknown }): JoinResult {
    if (typeof o.id === 'string' && typeof o.secret === 'string') {
      const p = this.players.get(o.id);
      if (!p || !this.deps.sameHash(p.secretHash, this.deps.hash(o.secret)))
        return { error: 'bad-identity', message: 'Não reconheci você nesta sala. Entre com um apelido.' };
      if (p.removed) return { error: 'removed', message: 'Você foi removido desta sala.' };
      return { player: p, outs: [] };
    }
    const nick = cleanNick(o.nick);
    if (!nick) return { error: 'bad-nick', message: 'O apelido precisa ter de 1 a 20 caracteres.' };
    const key = nickKey(nick);
    if (!key) return { error: 'bad-nick', message: 'Escolha um apelido com letras ou números.' };
    if ([...this.players.values()].some((p) => p.nickKey === key))
      return { error: 'nick-taken', message: 'Já tem alguém com esse apelido na sala.' };
    if (this.activePlayers().length >= this.deps.limits.maxPlayers)
      return { error: 'room-full', message: 'A sala está cheia.' };
    const secret = this.deps.secret();
    const p: Player = {
      id: this.deps.id(12),
      nick,
      nickKey: key,
      secretHash: this.deps.hash(secret),
      joinedAt: this.deps.now(),
      removed: false,
    };
    this.players.set(p.id, p);
    this.deps.store.savePlayer(this.code, p);
    if (
      this.creator === null &&
      this.creatorKeyHash &&
      typeof o.creatorKey === 'string' &&
      this.deps.sameHash(this.creatorKeyHash, this.deps.hash(o.creatorKey))
    ) {
      this.creator = p.id;
      this.creatorKeyHash = null;
      this.deps.store.saveRoom(this.record());
    }
    return { player: p, secret, outs: [] };
  }

  /** Mais uma conexão do jogador (pode haver várias abas). */
  connect(id: string): Out[] {
    const before = this.connections.get(id) ?? 0;
    this.connections.set(id, before + 1);
    this.touch();
    const p = this.players.get(id);
    if (before > 0 || !p) return [];
    const outs: Out[] = [{ to: null, msg: { t: 'player', player: this.playerView(p) } }];
    for (const t of this.tables.values()) if (t.game && G.setAway(t.game, id, null)) outs.push(...this.tableOut(t));
    return outs;
  }

  disconnect(id: string): Out[] {
    const n = (this.connections.get(id) ?? 0) - 1;
    this.touch();
    if (n > 0) {
      this.connections.set(id, n);
      return [];
    }
    this.connections.delete(id);
    this.chatBuckets.delete(id);
    this.reactBuckets.delete(id);
    const p = this.players.get(id);
    if (!p || p.removed) return [];
    const now = this.deps.now();
    const outs: Out[] = [{ to: null, msg: { t: 'player', player: this.playerView(p) } }];
    for (const t of this.tables.values()) if (t.game && G.setAway(t.game, id, now)) outs.push(...this.tableOut(t));
    return outs;
  }

  /** O criador remove alguém: perde as partidas em andamento, as mesas dele fecham e o segredo deixa de valer. */
  kick(actor: string, target: string): Out[] {
    if (actor !== this.creator || actor === target) return [err(actor, 'forbidden', 'kick')];
    const p = this.players.get(target);
    if (!p || p.removed) return [err(actor, 'not-allowed', 'kick', 'Essa pessoa não está na sala.')];
    p.removed = true;
    this.deps.store.savePlayer(this.code, p);
    const now = this.deps.now();
    const outs: Out[] = [];
    for (const t of [...this.tables.values()]) {
      if (t.status === 'playing' && t.game && G.forfeit(t.game, target, now)) outs.push(...this.gameEnded(t));
      else if (t.owner === target || t.challenged === target || (t.game && G.colorOf(t.game, target)))
        if (t.status !== 'playing') outs.push(...this.closeTable(t));
    }
    outs.push({ to: target, msg: { t: 'kicked' } }, { to: null, msg: { t: 'player.removed', id: target } });
    return outs;
  }

  // ------------------------------------------------------------ vistas

  tableView(t: Table): TableView {
    const now = this.deps.now();
    return {
      id: t.id,
      owner: t.owner,
      tc: t.tc,
      color: t.color,
      challenged: t.challenged,
      status: t.status,
      game: t.game ? G.view(t.game, now) : null,
      rematch: [...t.rematch],
      createdAt: t.createdAt,
    };
  }

  view(): RoomView {
    const chat = [...this.chat.values()].flat().sort((a, b) => a.at - b.at);
    return {
      code: this.code,
      graceMs: this.deps.limits.graceMs,
      creator: this.creator,
      players: this.activePlayers().map((p) => this.playerView(p)),
      tables: [...this.tables.values()].map((t) => this.tableView(t)),
      finished: [...this.finished],
      chat,
    };
  }

  private tableOut(t: Table): Out[] {
    return [{ to: null, msg: { t: 'table', table: this.tableView(t), now: this.deps.now() } }];
  }

  private persistTable(t: Table): void {
    this.deps.store.saveTable(this.code, {
      id: t.id,
      owner: t.owner,
      tc: t.tc,
      color: t.color,
      challenged: t.challenged,
      status: t.status,
      game: t.game ? G.snapshot(t.game) : null,
      rematch: [...t.rematch],
      createdAt: t.createdAt,
    });
  }

  private closeTable(t: Table): Out[] {
    this.tables.delete(t.id);
    this.chat.delete(t.id);
    this.deps.store.deleteTable(this.code, t.id);
    return [{ to: null, msg: { t: 'table.closed', id: t.id } }];
  }

  // ------------------------------------------------------------ mesas

  /** Está jogando (partida em andamento)? */
  private playing(id: string): boolean {
    for (const t of this.tables.values())
      if (t.status === 'playing' && t.game && G.colorOf(t.game, id)) return true;
    return false;
  }

  private openTablesOf(id: string): Table[] {
    return [...this.tables.values()].filter((t) => t.status === 'open' && t.owner === id);
  }

  openTable(actor: string, o: { tc: TimeControl | null; color: ColorChoice; challenged?: string }): Out[] {
    const ref = 'table.open';
    if (this.playing(actor)) return [err(actor, 'busy', ref, 'Termine sua partida antes de abrir outra mesa.')];
    let challenged: string | null = null;
    if (o.challenged !== undefined) {
      const p = this.players.get(o.challenged);
      if (!p || p.removed || p.id === actor) return [err(actor, 'not-allowed', ref, 'Não dá para desafiar essa pessoa.')];
      challenged = p.id;
    }
    const outs: Out[] = [];
    // Uma mesa aberta por pessoa: a nova substitui a anterior.
    for (const t of this.openTablesOf(actor)) outs.push(...this.closeTable(t));
    if (this.tables.size >= this.deps.limits.maxTables) return [...outs, err(actor, 'table-limit', ref)];
    const t: Table = {
      id: this.deps.id(8),
      owner: actor,
      tc: o.tc,
      color: o.color,
      challenged,
      status: 'open',
      game: null,
      rematch: new Set(),
      createdAt: this.deps.now(),
    };
    this.tables.set(t.id, t);
    this.persistTable(t);
    return [...outs, ...this.tableOut(t)];
  }

  sit(actor: string, tableId: string): Out[] {
    const ref = 'table.sit';
    const t = this.tables.get(tableId);
    if (!t) return [err(actor, 'table-not-found', ref)];
    if (t.status !== 'open' || t.owner === actor) return [err(actor, 'not-allowed', ref)];
    if (t.challenged && t.challenged !== actor) return [err(actor, 'forbidden', ref, 'Esse desafio é para outra pessoa.')];
    if (this.playing(actor) || this.playing(t.owner)) return [err(actor, 'busy', ref)];
    const outs: Out[] = [];
    for (const other of this.openTablesOf(actor)) outs.push(...this.closeTable(other));
    const ownerWhite = t.color === 'white' || (t.color === 'random' && this.deps.random() < 0.5);
    this.startGame(t, ownerWhite ? t.owner : actor, ownerWhite ? actor : t.owner);
    return [...outs, ...this.tableOut(t)];
  }

  private startGame(t: Table, white: string, black: string): void {
    t.game = G.createGame({
      id: this.deps.id(10),
      white,
      black,
      whiteNick: this.players.get(white)?.nick ?? '?',
      blackNick: this.players.get(black)?.nick ?? '?',
      tc: t.tc,
      now: this.deps.now(),
    });
    for (const id of [white, black]) if (!this.isOnline(id)) G.setAway(t.game, id, this.deps.now());
    t.status = 'playing';
    t.rematch.clear();
    this.persistTable(t);
  }

  /** Sair da mesa: o dono cancela a mesa aberta, o desafiado recusa, e qualquer um dos dois fecha a mesa terminada. */
  leave(actor: string, tableId: string): Out[] {
    const ref = 'table.leave';
    const t = this.tables.get(tableId);
    if (!t) return [err(actor, 'table-not-found', ref)];
    if (t.status === 'open' && (t.owner === actor || t.challenged === actor)) return this.closeTable(t);
    if (t.status === 'finished' && t.game && G.colorOf(t.game, actor)) return this.closeTable(t);
    if (t.status === 'playing') return [err(actor, 'not-allowed', ref, 'Desista ou aborte a partida antes de sair.')];
    return [err(actor, 'forbidden', ref)];
  }

  // ------------------------------------------------------------ partida

  private gameTable(actor: string, tableId: string, ref: string): Table | Out[] {
    const t = this.tables.get(tableId);
    if (!t || !t.game) return [err(actor, 'table-not-found', ref)];
    if (!G.colorOf(t.game, actor)) return [err(actor, 'forbidden', ref)];
    return t;
  }

  private afterOutcome(actor: string, t: Table, o: Outcome, ref: string): Out[] {
    const outs: Out[] = [];
    if (o.error) outs.push(err(actor, o.error, ref));
    const g = t.game!;
    if (o.moved) {
      outs.push({
        to: null,
        msg: {
          t: 'move',
          table: t.id,
          seq: g.moves.length,
          uci: o.moved.uci,
          san: o.moved.san,
          fen: g.chess.fen(),
          clock: g.clock ? clk.view(g.clock, this.deps.now()) : null,
          now: this.deps.now(),
        },
      });
    }
    if (o.ended) outs.push(...this.gameEnded(t));
    else if (o.changed) outs.push(...this.tableOut(t));
    if (o.moved || o.changed) this.persistTable(t);
    return outs;
  }

  /** Fecha a partida: grava o PGN (link permanente) e avisa a sala. */
  private gameEnded(t: Table): Out[] {
    const g = t.game!;
    t.status = 'finished';
    t.rematch.clear();
    const fv: FinishedView = {
      id: g.id,
      whiteNick: g.whiteNick,
      blackNick: g.blackNick,
      result: g.result!,
      reason: g.reason!,
      plies: g.moves.length,
      tc: g.tc,
      endedAt: g.endedAt ?? this.deps.now(),
    };
    this.deps.store.saveFinished(this.code, {
      ...fv,
      white: g.white,
      black: g.black,
      pgn: G.toPgn(g, this.deps.site(g.id)),
      finalFen: g.chess.fen(),
      startedAt: g.startedAt,
    });
    this.persistTable(t);
    this.finished.unshift(fv);
    this.finished.length = Math.min(this.finished.length, this.deps.limits.keepFinished);
    return [...this.tableOut(t), { to: null, msg: { t: 'finished', game: fv } }];
  }

  move(actor: string, tableId: string, seq: number, uci: string): Out[] {
    const t = this.gameTable(actor, tableId, 'move');
    if (Array.isArray(t)) return t;
    return this.afterOutcome(actor, t, G.applyMove(t.game!, actor, seq, uci, this.deps.now()), 'move');
  }

  resign(actor: string, tableId: string): Out[] {
    const t = this.gameTable(actor, tableId, 'resign');
    if (Array.isArray(t)) return t;
    return this.afterOutcome(actor, t, G.resign(t.game!, actor, this.deps.now()), 'resign');
  }

  abort(actor: string, tableId: string): Out[] {
    const t = this.gameTable(actor, tableId, 'abort');
    if (Array.isArray(t)) return t;
    if (!G.canAbort(t.game!)) return [err(actor, 'not-allowed', 'abort', 'Só dá para abortar antes do primeiro lance de cada lado.')];
    return this.closeTable(t);
  }

  draw(actor: string, tableId: string, action: 'offer' | 'accept' | 'decline'): Out[] {
    const t = this.gameTable(actor, tableId, 'draw');
    if (Array.isArray(t)) return t;
    return this.afterOutcome(actor, t, G.draw(t.game!, actor, action, this.deps.now()), 'draw');
  }

  takeback(actor: string, tableId: string, action: 'request' | 'accept' | 'decline'): Out[] {
    const t = this.gameTable(actor, tableId, 'takeback');
    if (Array.isArray(t)) return t;
    return this.afterOutcome(actor, t, G.takeback(t.game!, actor, action, this.deps.now()), 'takeback');
  }

  claim(actor: string, tableId: string): Out[] {
    const t = this.gameTable(actor, tableId, 'claim');
    if (Array.isArray(t)) return t;
    const o = G.claimVictory(t.game!, actor, this.deps.now(), this.deps.limits.graceMs);
    if (o.error === 'not-allowed')
      return [err(actor, 'not-allowed', 'claim', 'Ainda não: o adversário pode voltar dentro do prazo de tolerância.')];
    return this.afterOutcome(actor, t, o, 'claim');
  }

  /** Revanche na mesma mesa, com as cores trocadas, quando os dois pedirem. */
  rematch(actor: string, tableId: string): Out[] {
    const ref = 'rematch';
    const t = this.tables.get(tableId);
    if (!t || !t.game) return [err(actor, 'table-not-found', ref)];
    const color = G.colorOf(t.game, actor);
    if (!color) return [err(actor, 'forbidden', ref)];
    if (t.status !== 'finished') return [err(actor, 'not-allowed', ref)];
    const opponent = color === 'w' ? t.game.black : t.game.white;
    const opp = this.players.get(opponent);
    if (!opp || opp.removed) return [err(actor, 'not-allowed', ref, 'O adversário saiu da sala.')];
    t.rematch.add(actor);
    if (t.rematch.has(opponent)) {
      if (this.playing(actor) || this.playing(opponent)) {
        t.rematch.delete(actor);
        return [err(actor, 'busy', ref)];
      }
      const prev = t.game;
      this.startGame(t, prev.black, prev.white);
    } else this.persistTable(t);
    return this.tableOut(t);
  }

  // ------------------------------------------------------------ relógio

  /** Milissegundos até o próximo relógio estourar em alguma mesa (null: nenhum correndo). */
  nextFlagIn(): number | null {
    const now = this.deps.now();
    let min: number | null = null;
    for (const t of this.tables.values()) {
      if (t.status !== 'playing' || !t.game?.clock) continue;
      const ms = clk.msUntilFlag(t.game.clock, now);
      if (ms !== null && (min === null || ms < min)) min = ms;
    }
    return min;
  }

  /** Encerra por tempo as partidas cujo relógio estourou. */
  tick(): Out[] {
    const now = this.deps.now();
    const outs: Out[] = [];
    for (const t of this.tables.values()) {
      if (t.status === 'playing' && t.game && G.checkTimeout(t.game, now)) outs.push(...this.gameEnded(t));
    }
    return outs;
  }

  // ------------------------------------------------------------ chat e reações

  private validChannel(channel: string): boolean {
    return channel === 'room' || this.tables.has(channel);
  }

  say(actor: string, channel: string, raw: unknown): Out[] {
    const ref = 'chat';
    if (!this.validChannel(channel)) return [err(actor, 'not-allowed', ref, 'Esse chat não existe mais.')];
    const text = cleanChat(raw);
    if (!text) return [err(actor, 'bad-message', ref, 'A mensagem precisa ter de 1 a 300 caracteres.')];
    const now = this.deps.now();
    let b = this.chatBuckets.get(actor);
    if (!b) this.chatBuckets.set(actor, (b = new Bucket(this.deps.limits.chatBurst, this.deps.limits.chatPerSecond, now)));
    if (!b.take(now)) return [err(actor, 'rate-limited', ref, 'Calma: espere um pouco para mandar outra mensagem.')];
    const p = this.players.get(actor)!;
    const msg: ChatMessage = { channel, from: actor, nick: p.nick, text, at: now };
    const list = this.chat.get(channel) ?? [];
    list.push(msg);
    if (list.length > this.deps.limits.keepChat) list.splice(0, list.length - this.deps.limits.keepChat);
    this.chat.set(channel, list);
    return [{ to: null, msg: { t: 'chat', msg } }];
  }

  react(actor: string, channel: string, emoji: string): Out[] {
    if (!this.validChannel(channel)) return [err(actor, 'not-allowed', 'react')];
    if (!(REACTIONS as readonly string[]).includes(emoji)) return [err(actor, 'bad-message', 'react')];
    const now = this.deps.now();
    let b = this.reactBuckets.get(actor);
    if (!b) this.reactBuckets.set(actor, (b = new Bucket(this.deps.limits.reactBurst, this.deps.limits.reactPerSecond, now)));
    if (!b.take(now)) return [];
    return [{ to: null, msg: { t: 'react', channel, from: actor, emoji } }];
  }

  // ------------------------------------------------------------ expiração

  /** Ninguém conectado há mais de `ttlMs`. */
  expired(ttlMs: number): boolean {
    return this.onlineCount() === 0 && this.deps.now() - this.activeAt > ttlMs;
  }

  persistActivity(): void {
    this.deps.store.saveRoom(this.record());
  }
}

// Tela da mesa: tabuleiro, relógios, lista de lances, capturas, ofertas (empate, voltar lance, revanche),
// reivindicação por abandono e o chat da partida. Serve a quem joga e a quem assiste.
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import type { ClientMessage, Color, GameView, TableView } from '../../../shared/protocol.ts';
import { captured, capturedRow, cgColor, Chess, choosePromotion, createBoard, isPromotion, lastMoveOf, legalDests } from '../board.ts';
import { copyText, h, replace, toast } from '../dom.ts';
import { fmtClock, fmtTc, resultText, sanPt } from '../format.ts';
import { moveSound, sound } from '../sound.ts';
import { prefs } from '../storage.ts';
import { ChatBox } from './chat.ts';
import type { RoomState } from './state.ts';

export interface GameActions {
  send(m: ClientMessage): boolean;
  back(): void;
  serverNow(): number;
}

interface PlayerBar {
  el: HTMLElement;
  name: HTMLElement;
  dot: HTMLElement;
  caps: HTMLElement;
  clock: HTMLElement;
}

function bar(): PlayerBar {
  const name = h('span', { class: 'pb-name' });
  const dot = h('span', { class: 'side' });
  const caps = h('span', { class: 'pb-caps' });
  const clock = h('span', { class: 'clock', role: 'timer', 'aria-live': 'off' });
  return { el: h('div', { class: 'player-bar' }, h('span', { class: 'pb-who' }, dot, name), caps, clock), name, dot, caps, clock };
}

export class GameScreen {
  readonly el: HTMLElement;
  readonly tableId: string;
  readonly chat: ChatBox;
  private s: RoomState;
  private a: GameActions;
  private boardEl = h('div', { class: 'cg-wrap' });
  private cg: Api;
  private chess = new Chess();
  /** Lances (UCI) que o chess local já tem, vindos do servidor. */
  private synced: string[] = [];
  private gameId: string | null = null;
  private pending: { seq: number; uci: string } | null = null;
  private flipped = false;
  private top = bar();
  private bottom = bar();
  private status = h('p', { class: 'game-status', 'aria-live': 'polite' });
  private moveList = h('ol', { class: 'move-list', 'aria-label': 'Lances' });
  private controls = h('div', { class: 'game-controls' });
  private banners = h('div', { class: 'banners' });
  private ticker: number;
  private lowTimeWarned = false;
  private lastControlsKey = '';

  constructor(s: RoomState, tableId: string, a: GameActions) {
    this.s = s;
    this.a = a;
    this.tableId = tableId;
    this.chat = new ChatBox({
      channel: tableId,
      title: 'Chat da partida',
      send: (text) => a.send({ t: 'chat', channel: tableId, text }),
      react: (emoji) => a.send({ t: 'react', channel: tableId, emoji }),
    });
    this.cg = createBoard(this.boardEl, {
      orientation: 'white',
      movable: { free: false, showDests: true, events: { after: (o, d) => void this.userMove(o, d) } },
      premovable: { enabled: true, showDests: true, castle: true },
    });
    const boardBox = h('div', { class: 'board-box' }, this.top.el, h('div', { class: 'board-wrap' }, this.boardEl), this.bottom.el);
    this.el = h(
      'div',
      { class: 'game-screen' },
      h(
        'div',
        { class: 'game-head' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => a.back() }, '← Lobby'),
        h('span', { class: 'game-title' }),
      ),
      h(
        'div',
        { class: 'game-layout' },
        boardBox,
        h(
          'div',
          { class: 'game-side' },
          h('section', { class: 'card' }, this.status, this.banners, this.controls, this.moveList),
          this.chat.el,
        ),
      ),
    );
    this.ticker = window.setInterval(() => this.tick(), 100);
    this.update();
  }

  destroy(): void {
    clearInterval(this.ticker);
    this.cg.destroy();
  }

  private table(): TableView | undefined {
    return this.s.table(this.tableId);
  }

  private myColor(g: GameView | null): Color | null {
    const me = this.s.me?.id;
    if (!g || !me) return null;
    return g.white === me ? 'w' : g.black === me ? 'b' : null;
  }

  private orientation(g: GameView | null): Color {
    const mine = this.myColor(g);
    const base: Color = mine ?? 'w';
    return this.flipped ? (base === 'w' ? 'b' : 'w') : base;
  }

  /** Refaz o chess local a partir dos lances do servidor, só quando eles mudaram. */
  private syncChess(g: GameView): void {
    const same = g.id === this.gameId && g.moves.length === this.synced.length && g.moves.every((m, i) => m === this.synced[i]);
    if (same) return;
    // Lance novo no fim: aplica só ele (mantém repetições e animação). Senão (voltar lance, revanche), refaz tudo.
    const appended =
      g.id === this.gameId && g.moves.length === this.synced.length + 1 && this.synced.every((m, i) => m === g.moves[i]);
    if (!appended) {
      this.chess = new Chess();
      for (const uci of g.moves) this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (g.id !== this.gameId) this.lowTimeWarned = false;
    } else {
      const uci = g.moves.at(-1)!;
      this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    }
    this.gameId = g.id;
    this.synced = [...g.moves];
  }

  /** Atualiza tudo a partir do estado (chamado em `table` e `move` desta mesa). */
  update(): void {
    const t = this.table();
    if (!t) return;
    const g = t.game;
    const title = this.el.querySelector('.game-title')!;
    if (!g) {
      title.textContent = `Mesa ${fmtTc(t.tc)}`;
      this.renderWaiting(t);
      return;
    }
    title.textContent = `${g.whiteNick} × ${g.blackNick} · ${fmtTc(g.tc)}`;
    // Lance pendente confirmado (ou atropelado por outro estado): sai da fila.
    if (this.pending && g.moves.length > this.pending.seq) this.pending = null;
    this.syncChess(g);
    const display = new Chess(this.chess.fen());
    if (this.pending) {
      const p = this.pending.uci;
      try {
        display.move({ from: p.slice(0, 2), to: p.slice(2, 4), promotion: p[4] });
      } catch {
        this.pending = null;
      }
    }
    const mine = this.myColor(g);
    const over = !!g.result;
    const myTurn = !!mine && !over && !this.pending && this.chess.turn() === mine && t.status === 'playing';
    this.cg.set({
      fen: display.fen(),
      orientation: cgColor(this.orientation(g)),
      turnColor: cgColor(display.turn() as Color),
      lastMove: lastMoveOf(this.pending?.uci ?? g.moves.at(-1)),
      check: display.inCheck() ? cgColor(display.turn() as Color) : false,
      // Nunca viewOnly: o chessground só liga os eventos de mouse quando redesenha o tabuleiro, e a revanche vira o
      // tabuleiro (redesenho) ainda no estado da partida terminada; ficaria sem resposta. Quem não joga fica sem
      // movable.color, o que já impede mexer nas peças.
      movable: { color: mine && !over ? cgColor(mine) : undefined, dests: myTurn ? legalDests(this.chess) : new Map() },
      premovable: { enabled: !!mine && !over },
    });
    if (myTurn) this.cg.playPremove();
    if (over) this.cg.cancelPremove();
    this.renderBars(g);
    this.renderMoves(g);
    this.renderStatus(t, g);
    this.renderControls(t, g);
    this.chat.update(this.s.room?.chat ?? [], this.s.me?.id);
    this.tick();
  }

  /** Lance novo chegou pelo evento `move`: som (o resto vem do update). */
  onMove(san: string, seq: number): void {
    const mineConfirmed = this.pending && this.pending.seq === seq - 1;
    if (!mineConfirmed) moveSound(san);
    this.update();
  }

  /** O servidor recusou o lance que mandamos: volta o tabuleiro. */
  rejectPending(): void {
    if (!this.pending) return;
    this.pending = null;
    this.update();
  }

  private async userMove(orig: Key, dest: Key): Promise<void> {
    const t = this.table();
    const g = t?.game;
    const mine = this.myColor(g ?? null);
    if (!t || !g || !mine || g.result) return;
    let promo = '';
    if (isPromotion(this.chess, orig, dest)) {
      const choice = await choosePromotion(this.boardEl.parentElement as HTMLElement, mine);
      if (!choice) {
        this.update();
        return;
      }
      promo = choice;
    }
    const uci = `${orig}${dest}${promo}`;
    const seq = this.synced.length;
    let san = '';
    try {
      san = new Chess(this.chess.fen()).move({ from: orig, to: dest, promotion: promo || undefined }).san;
    } catch {
      this.update();
      return;
    }
    if (!this.a.send({ t: 'move', table: t.id, seq, uci })) {
      toast('Sem conexão: o lance não foi enviado.', 'error');
      this.update();
      return;
    }
    this.pending = { seq, uci };
    moveSound(san);
    this.update();
  }

  private remaining(g: GameView, c: Color): number | null {
    if (!g.clock) return null;
    const base = c === 'w' ? g.clock.whiteMs : g.clock.blackMs;
    if (g.clock.running !== c || g.result) return base;
    const at = this.s.clockAt.get(this.tableId) ?? this.a.serverNow();
    return base - (this.a.serverNow() - at);
  }

  private tick(): void {
    const g = this.table()?.game;
    if (!g) return;
    const bottomColor = this.orientation(g);
    const topColor: Color = bottomColor === 'w' ? 'b' : 'w';
    for (const [b, c] of [
      [this.bottom, bottomColor],
      [this.top, topColor],
    ] as const) {
      const ms = this.remaining(g, c);
      b.clock.hidden = ms === null;
      if (ms === null) continue;
      b.clock.textContent = fmtClock(ms);
      const running = g.clock?.running === c && !g.result;
      b.clock.classList.toggle('clock-running', running);
      b.clock.classList.toggle('clock-low', ms < 10_000);
      if (running && c === this.myColor(g) && ms < 10_000 && !this.lowTimeWarned) {
        this.lowTimeWarned = true;
        sound.lowTime();
      }
    }
    this.renderClaim(g);
  }

  private renderBars(g: GameView): void {
    const bottomColor = this.orientation(g);
    const caps = captured(g.fen);
    for (const [b, c] of [
      [this.bottom, bottomColor],
      [this.top, bottomColor === 'w' ? 'b' : 'w'],
    ] as const) {
      const id = c === 'w' ? g.white : g.black;
      const on = this.s.online(id);
      b.name.textContent = `${c === 'w' ? g.whiteNick : g.blackNick}${id === this.s.me?.id ? ' (você)' : ''}${on ? '' : ' · desconectado'}`;
      b.dot.className = `side side-${c}`;
      b.dot.setAttribute('aria-label', c === 'w' ? 'brancas' : 'pretas');
      // As peças que esta cor capturou são da outra cor.
      replace(b.caps, capturedRow(c === 'w' ? caps.byWhite : caps.byBlack, c === 'w' ? 'b' : 'w', c === 'w' ? caps.diff : -caps.diff));
    }
  }

  private renderMoves(g: GameView): void {
    const rows: HTMLElement[] = [];
    for (let i = 0; i < g.sans.length; i += 2) {
      rows.push(
        h(
          'li',
          null,
          h('span', { class: 'mv-n' }, `${i / 2 + 1}.`),
          h('span', { class: ['mv', i === g.sans.length - 1 && 'mv-last'] }, sanPt(g.sans[i]!)),
          h('span', { class: ['mv', i + 1 === g.sans.length - 1 && 'mv-last'] }, sanPt(g.sans[i + 1] ?? '')),
        ),
      );
    }
    replace(this.moveList, rows.length ? rows : h('li', { class: 'muted' }, 'Nenhum lance ainda.'));
    this.moveList.scrollTop = this.moveList.scrollHeight;
  }

  private renderStatus(t: TableView, g: GameView): void {
    if (g.result && g.reason) {
      this.status.textContent = `${g.result} · ${resultText(g.result, g.reason, g.whiteNick, g.blackNick)}`;
      this.status.className = 'game-status status-over';
      return;
    }
    const turn = this.chess.turn() as Color;
    const mine = this.myColor(g);
    this.status.className = 'game-status';
    if (t.status !== 'playing') this.status.textContent = '';
    else if (mine) this.status.textContent = turn === mine ? 'Sua vez.' : 'Vez do adversário.';
    else this.status.textContent = `Vez das ${turn === 'w' ? 'brancas' : 'pretas'}.`;
    if (g.moves.length < 2 && mine) this.status.textContent += ' O relógio começa depois do primeiro lance de cada lado.';
  }

  private claimEl: HTMLElement | null = null;

  /** Adversário desconectado: contagem da tolerância e, depois dela, o botão de reivindicar. */
  private renderClaim(g: GameView): void {
    const mine = this.myColor(g);
    const opp: Color | null = mine ? (mine === 'w' ? 'b' : 'w') : null;
    const since = opp ? g.awaySince[opp] : null;
    if (!opp || since === null || g.result) {
      this.claimEl?.remove();
      this.claimEl = null;
      return;
    }
    const left = since + (this.s.room?.graceMs ?? 60_000) - this.a.serverNow();
    const nick = opp === 'w' ? g.whiteNick : g.blackNick;
    if (!this.claimEl) {
      this.claimEl = h('div', { class: 'banner banner-warn' });
      this.banners.prepend(this.claimEl);
    }
    const key = left > 0 ? `wait:${Math.ceil(left / 1000)}` : 'claim';
    if (this.claimEl.dataset.key === key) return;
    this.claimEl.dataset.key = key;
    if (left > 0) replace(this.claimEl, `${nick} desconectou. Se não voltar em ${Math.ceil(left / 1000)} s, você pode reivindicar a vitória.`);
    else
      replace(
        this.claimEl,
        `${nick} não voltou. `,
        h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => this.a.send({ t: 'claim', table: this.tableId }) }, 'Reivindicar vitória'),
      );
  }

  private renderControls(t: TableView, g: GameView): void {
    const mine = this.myColor(g);
    const me = this.s.me?.id ?? '';
    const opp: Color | null = mine ? (mine === 'w' ? 'b' : 'w') : null;
    const oppId = opp ? (opp === 'w' ? g.white : g.black) : '';
    const key = JSON.stringify([t.status, g.id, g.result, g.drawOffer, g.takebackRequest, t.rematch, g.moves.length < 2, this.flipped, prefs.sound(), this.s.online(oppId)]);
    if (key === this.lastControlsKey) return;
    this.lastControlsKey = key;
    const send = (m: ClientMessage) => this.a.send(m);
    const tid = t.id;
    const btn = (label: string, onclick: () => void, cls = 'btn') => h('button', { type: 'button', class: cls, onclick }, label);

    const banners: HTMLElement[] = [];
    if (!g.result && mine) {
      if (g.drawOffer === opp)
        banners.push(
          h('div', { class: 'banner' }, `${this.s.nick(oppId)} propõe empate. `,
            btn('Aceitar', () => send({ t: 'draw', table: tid, action: 'accept' }), 'btn btn-small btn-primary'),
            btn('Recusar', () => send({ t: 'draw', table: tid, action: 'decline' }), 'btn btn-small')),
        );
      if (g.drawOffer === mine) banners.push(h('div', { class: 'banner banner-muted' }, 'Você propôs empate. Esperando resposta…'));
      if (g.takebackRequest === opp)
        banners.push(
          h('div', { class: 'banner' }, `${this.s.nick(oppId)} pede para voltar o lance. `,
            btn('Aceitar', () => send({ t: 'takeback', table: tid, action: 'accept' }), 'btn btn-small btn-primary'),
            btn('Recusar', () => send({ t: 'takeback', table: tid, action: 'decline' }), 'btn btn-small')),
        );
      if (g.takebackRequest === mine) banners.push(h('div', { class: 'banner banner-muted' }, 'Você pediu para voltar o lance. Esperando resposta…'));
    }
    if (!g.result && !mine && (g.drawOffer || g.takebackRequest))
      banners.push(h('div', { class: 'banner banner-muted' }, g.drawOffer ? 'Empate proposto.' : 'Pedido para voltar o lance.'));
    if (g.result && t.status === 'finished' && mine) {
      const iAsked = t.rematch.includes(me);
      const theyAsked = t.rematch.includes(oppId);
      if (theyAsked && !iAsked)
        banners.push(h('div', { class: 'banner' }, `${this.s.nick(oppId)} quer revanche. `, btn('Aceitar', () => send({ t: 'rematch', table: tid }), 'btn btn-small btn-primary')));
      if (iAsked) banners.push(h('div', { class: 'banner banner-muted' }, 'Revanche pedida. Esperando o adversário…'));
    }
    const claim = this.claimEl;
    replace(this.banners, banners);
    if (claim) this.banners.prepend(claim);

    const c: HTMLElement[] = [];
    if (mine && !g.result) {
      if (g.moves.length < 2) c.push(btn('Abortar', () => send({ t: 'abort', table: tid })));
      c.push(btn('Voltar lance', () => send({ t: 'takeback', table: tid, action: 'request' })));
      c.push(btn(g.drawOffer === opp ? 'Aceitar empate' : 'Propor empate', () => send({ t: 'draw', table: tid, action: 'offer' })));
      c.push(
        btn('Desistir', () => {
          if (confirm('Desistir da partida?')) send({ t: 'resign', table: tid });
        }, 'btn btn-danger'),
      );
    }
    if (g.result) {
      if (mine && t.status === 'finished' && !t.rematch.includes(me) && !t.rematch.includes(oppId)) c.push(btn('Revanche', () => send({ t: 'rematch', table: tid }), 'btn btn-primary'));
      c.push(h('a', { class: 'btn', href: `/p/${g.id}`, target: '_blank', rel: 'noopener' }, 'Rever a partida'));
      if (mine) c.push(btn('Sair da mesa', () => send({ t: 'table.leave', table: tid })));
    }
    if (!mine) c.push(btn('Virar tabuleiro', () => {
      this.flipped = !this.flipped;
      this.lastControlsKey = '';
      this.update();
    }));
    c.push(
      btn(prefs.sound() ? '🔊 Som' : '🔇 Som', () => {
        prefs.setSound(!prefs.sound());
        this.lastControlsKey = '';
        this.update();
      }, 'btn btn-ghost'),
    );
    replace(this.controls, c);
  }

  private renderWaiting(t: TableView): void {
    this.cg.set({ fen: 'start', lastMove: undefined, check: false, orientation: 'white', movable: { color: undefined, dests: new Map() } });
    const me = this.s.me?.id;
    this.status.className = 'game-status';
    this.status.textContent = t.challenged
      ? `Desafio de ${this.s.nick(t.owner)} para ${this.s.nick(t.challenged)}: esperando resposta.`
      : `Mesa de ${this.s.nick(t.owner)} esperando adversário.`;
    replace(this.banners);
    replace(this.moveList);
    const c: HTMLElement[] = [];
    if (t.owner === me) {
      c.push(h('button', { type: 'button', class: 'btn', onclick: () => this.a.send({ t: 'table.leave', table: t.id }) }, 'Cancelar mesa'));
      c.push(
        h('button', { type: 'button', class: 'btn', onclick: async () => toast((await copyText(location.href.split('#')[0]!)) ? 'Convite copiado.' : 'Não consegui copiar.') }, 'Copiar convite da sala'),
      );
    } else if (!t.challenged || t.challenged === me)
      c.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.a.send({ t: 'table.sit', table: t.id }) }, 'Sentar e jogar'));
    replace(this.controls, c);
    this.lastControlsKey = '';
    for (const b of [this.top, this.bottom]) {
      b.name.textContent = '';
      b.clock.hidden = true;
      replace(b.caps);
    }
  }
}

// Partida contra o computador (/bot): tudo no navegador, sem passar pelo servidor. A partida em andamento fica no
// localStorage, para continuar depois de recarregar.
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import type { Color } from '../../../shared/protocol.ts';
import { cgColor, Chess, choosePromotion, createBoard, isPromotion, lastMoveOf, legalDests } from '../board.ts';
import { copyText, h, replace, toast } from '../dom.ts';
import { sanPt } from '../format.ts';
import { moveSound, sound } from '../sound.ts';
import { prefs } from '../storage.ts';
import { Engine, LEVELS } from './engine.ts';

const SAVE_KEY = 'xadrez:bot';

interface Saved {
  level: number;
  color: Color;
  moves: string[];
  resigned?: boolean;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function save(s: Saved | null): void {
  try {
    if (s) localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    else localStorage.removeItem(SAVE_KEY);
  } catch {}
}

const uciMove = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

export function mountBot(root: HTMLElement): void {
  document.title = 'Contra o computador · Xadrez';
  let engine: Engine | null = null;
  let cg: Api | null = null;
  let chess = new Chess();
  let state: Saved = load() ?? { level: 2, color: 'w', moves: [] };
  /** Muda a cada nova partida ou volta de lance: respostas antigas do motor são descartadas. */
  let generation = 0;
  let thinking = false;

  const main = h('main', { class: 'room-main' });
  replace(root, h('header', { class: 'topbar' }, h('a', { class: 'brand', href: '/' }, '♞ Xadrez'), h('span', { class: 'room-code' }, 'Contra o computador')), main);

  const boardEl = h('div', { class: 'cg-wrap' });
  const status = h('p', { class: 'game-status', 'aria-live': 'polite' });
  const moveList = h('ol', { class: 'move-list', 'aria-label': 'Lances' });
  const levelSel = h(
    'select',
    { class: 'select', 'aria-label': 'Nível', onchange: () => (state.level = Number(levelSel.value)) },
    LEVELS.map((l, i) => h('option', { value: String(i) }, l.label)),
  );
  const colorSel = h(
    'select',
    { class: 'select', 'aria-label': 'Sua cor' },
    h('option', { value: 'w' }, 'Brancas'),
    h('option', { value: 'b' }, 'Pretas'),
    h('option', { value: 'r' }, 'Sorteio'),
  );

  function ensureEngine(): Engine {
    if (!engine) {
      engine = new Engine();
      engine.whenReady().catch((e: Error) => {
        status.textContent = `O computador não carregou: ${e.message}`;
      });
    }
    return engine;
  }

  function over(): string | null {
    if (state.resigned) return 'Você desistiu.';
    if (chess.isCheckmate()) return chess.turn() === state.color ? 'Xeque-mate. O computador venceu.' : 'Xeque-mate! Você venceu.';
    if (chess.isStalemate()) return 'Empate por afogamento.';
    if (chess.isInsufficientMaterial()) return 'Empate por material insuficiente.';
    if (chess.isThreefoldRepetition()) return 'Empate por tripla repetição.';
    if (chess.isDrawByFiftyMoves()) return 'Empate pela regra dos 50 lances.';
    return null;
  }

  function render(): void {
    if (!cg) return;
    const end = over();
    const myTurn = !end && !thinking && chess.turn() === state.color;
    const last = state.moves.at(-1);
    cg.set({
      fen: chess.fen(),
      orientation: cgColor(state.color),
      turnColor: cgColor(chess.turn() as Color),
      lastMove: lastMoveOf(last),
      check: chess.inCheck() ? cgColor(chess.turn() as Color) : false,
      movable: { color: end ? undefined : cgColor(state.color), dests: myTurn ? legalDests(chess) : new Map() },
      premovable: { enabled: !end },
    });
    if (myTurn) cg.playPremove();
    status.textContent = end ?? (thinking ? 'O computador está pensando…' : chess.turn() === state.color ? 'Sua vez.' : '');
    status.className = `game-status${end ? ' status-over' : ''}`;
    const sans = chess.history();
    const rows: HTMLElement[] = [];
    for (let i = 0; i < sans.length; i += 2)
      rows.push(
        h(
          'li',
          null,
          h('span', { class: 'mv-n' }, `${i / 2 + 1}.`),
          h('span', { class: ['mv', i === sans.length - 1 && 'mv-last'] }, sanPt(sans[i]!)),
          h('span', { class: ['mv', i + 1 === sans.length - 1 && 'mv-last'] }, sanPt(sans[i + 1] ?? '')),
        ),
      );
    replace(moveList, rows.length ? rows : h('li', { class: 'muted' }, 'Nenhum lance ainda.'));
    moveList.scrollTop = moveList.scrollHeight;
    save(state);
  }

  function apply(uci: string): string {
    const san = chess.move(uciMove(uci)).san;
    state.moves.push(uci);
    return san;
  }

  async function botMove(): Promise<void> {
    if (over() || chess.turn() === state.color) return;
    const gen = generation;
    thinking = true;
    render();
    try {
      const mv = await ensureEngine().bestMove(chess.fen(), LEVELS[state.level] ?? LEVELS[0]!);
      if (gen !== generation) return;
      thinking = false;
      if (mv) moveSound(apply(mv));
      if (over()) sound.end();
    } catch (e) {
      if (gen === generation) {
        thinking = false;
        toast(`O computador falhou: ${(e as Error).message}`, 'error');
      }
    }
    render();
  }

  async function userMove(orig: Key, dest: Key): Promise<void> {
    let promo = '';
    if (isPromotion(chess, orig, dest)) {
      const choice = await choosePromotion(boardEl.parentElement as HTMLElement, state.color);
      if (!choice) return render();
      promo = choice;
    }
    try {
      moveSound(apply(`${orig}${dest}${promo}`));
    } catch {
      return render();
    }
    if (over()) sound.end();
    render();
    void botMove();
  }

  function newGame(): void {
    generation++;
    engine?.stop();
    thinking = false;
    const c = colorSel.value;
    state = { level: Number(levelSel.value), color: c === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : (c as Color), moves: [] };
    chess = new Chess();
    ensureEngine().newGame();
    sound.start();
    render();
    void botMove();
  }

  function takeback(): void {
    if (state.resigned || state.moves.length === 0) return;
    generation++;
    engine?.stop();
    thinking = false;
    // Volta o seu último lance (e a resposta do computador, se já veio).
    const n = chess.turn() === state.color ? 2 : 1;
    for (let i = 0; i < n && state.moves.length > 0; i++) {
      chess.undo();
      state.moves.pop();
    }
    render();
    void botMove();
  }

  const btn = (label: string, onclick: () => void, cls = 'btn') => h('button', { type: 'button', class: cls, onclick }, label);
  replace(
    main,
    h(
      'div',
      { class: 'game-layout' },
      h('div', { class: 'board-box' }, h('div', { class: 'board-wrap' }, boardEl)),
      h(
        'div',
        { class: 'game-side' },
        h(
          'section',
          { class: 'card' },
          h('h2', null, 'Contra o computador'),
          h('div', { class: 'bot-settings' }, h('label', null, 'Nível ', levelSel), h('label', null, 'Você joga de ', colorSel)),
          h('div', { class: 'game-controls' }, btn('Nova partida', newGame, 'btn btn-primary')),
          h('p', { class: 'muted small' }, 'O computador é o Stockfish, rodando no seu navegador. A partida não passa pelo servidor.'),
        ),
        h(
          'section',
          { class: 'card' },
          status,
          h(
            'div',
            { class: 'game-controls' },
            btn('Voltar lance', takeback),
            btn('Desistir', () => {
              if (over() || !confirm('Desistir da partida?')) return;
              generation++;
              engine?.stop();
              thinking = false;
              state.resigned = true;
              sound.end();
              render();
            }, 'btn btn-danger'),
            btn('Copiar PGN', async () => {
              const c = new Chess();
              for (const u of state.moves) c.move(uciMove(u));
              c.setHeader('Event', 'Contra o computador');
              c.setHeader('White', state.color === 'w' ? 'Você' : `Stockfish nível ${state.level + 1}`);
              c.setHeader('Black', state.color === 'b' ? 'Você' : `Stockfish nível ${state.level + 1}`);
              toast((await copyText(c.pgn())) ? 'PGN copiado.' : 'Não consegui copiar.');
            }),
            btn(prefs.sound() ? '🔊 Som' : '🔇 Som', (ev?: unknown) => {
              prefs.setSound(!prefs.sound());
              const b = (ev as Event | undefined)?.currentTarget as HTMLElement | undefined;
              if (b) b.textContent = prefs.sound() ? '🔊 Som' : '🔇 Som';
            }, 'btn btn-ghost'),
          ),
          moveList,
        ),
      ),
    ),
  );

  levelSel.value = String(state.level);
  colorSel.value = state.color;
  for (const u of state.moves) {
    try {
      chess.move(uciMove(u));
    } catch {
      state.moves = [];
      chess = new Chess();
      break;
    }
  }
  cg = createBoard(boardEl, {
    movable: { free: false, showDests: true, events: { after: (o, d) => void userMove(o, d) } },
    premovable: { enabled: true, showDests: true },
  });
  render();
  ensureEngine();
  void botMove();
}

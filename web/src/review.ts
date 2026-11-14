// Revisão de partida terminada (/p/<id>): navegar pelos lances, copiar o FEN de qualquer posição e baixar o PGN.
import type { Api } from 'chessground/api';
import type { EndReason, Result, TimeControl } from '../../shared/protocol.ts';
import { cgColor, Chess, createBoard, lastMoveOf } from './board.ts';
import { copyText, h, replace, toast } from './dom.ts';
import { fmtDate, fmtTc, resultText, sanPt } from './format.ts';

interface StoredGame {
  id: string;
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

interface Ply {
  san: string;
  uci: string;
  fen: string;
  check: boolean;
}

export async function mountReview(root: HTMLElement, id: string): Promise<void> {
  document.title = 'Partida · Xadrez';
  const main = h('main', { class: 'room-main' }, h('p', { class: 'muted center' }, 'Carregando a partida…'));
  replace(root, h('header', { class: 'topbar' }, h('a', { class: 'brand', href: '/' }, '♞ Xadrez')), main);

  let game: StoredGame;
  try {
    const r = await fetch(`/api/games/${encodeURIComponent(id)}`);
    if (r.status === 404) {
      replace(main, h('section', { class: 'card join-card' }, h('h1', null, 'Partida não encontrada'), h('a', { class: 'btn btn-primary', href: '/' }, 'Ir para o início')));
      return;
    }
    if (!r.ok) throw new Error(`erro ${r.status}`);
    game = (await r.json()) as StoredGame;
  } catch (e) {
    replace(main, h('p', { class: 'form-error center' }, `Não consegui carregar a partida (${(e as Error).message}).`));
    return;
  }

  // Posições de cada lance, a partir do PGN gravado pelo servidor.
  const chess = new Chess();
  chess.loadPgn(game.pgn);
  const replay = new Chess();
  const start = replay.fen();
  const plies: Ply[] = chess.history({ verbose: true }).map((m) => {
    replay.move(m.san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fen: replay.fen(), check: replay.inCheck() };
  });

  const title = `${game.whiteNick} × ${game.blackNick}`;
  document.title = `${title} · Xadrez`;
  let cursor = plies.length;
  let orientation: 'w' | 'b' = 'w';

  const boardEl = h('div', { class: 'cg-wrap' });
  const fenInput = h('input', { type: 'text', readonly: true, class: 'fen', 'aria-label': 'FEN da posição', spellcheck: 'false' });
  const moveList = h('ol', { class: 'move-list review-moves', 'aria-label': 'Lances' });
  const counter = h('span', { class: 'muted small ply-counter', 'aria-live': 'polite' });
  let cg: Api;

  const fenAt = (i: number) => (i === 0 ? start : plies[i - 1]!.fen);

  function show(i: number): void {
    cursor = Math.max(0, Math.min(plies.length, i));
    const p = cursor > 0 ? plies[cursor - 1] : undefined;
    const turn = new Chess(fenAt(cursor)).turn();
    cg.set({
      fen: fenAt(cursor),
      lastMove: lastMoveOf(p?.uci),
      check: p?.check ? cgColor(turn) : false,
      orientation: cgColor(orientation),
    });
    fenInput.value = fenAt(cursor);
    counter.textContent = cursor === 0 ? 'Posição inicial' : `Lance ${Math.ceil(cursor / 2)}${cursor % 2 === 1 ? '' : '…'} ${sanPt(p?.san ?? '')} (${cursor}/${plies.length})`;
    for (const el of moveList.querySelectorAll<HTMLElement>('.mv')) {
      const on = Number(el.dataset.ply) === cursor;
      el.classList.toggle('mv-last', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    }
  }

  const rows: HTMLElement[] = [];
  for (let i = 0; i < plies.length; i += 2) {
    const cell = (k: number) =>
      plies[k]
        ? h('button', { type: 'button', class: 'mv mv-btn', dataset: { ply: String(k + 1) }, onclick: () => show(k + 1) }, sanPt(plies[k]!.san))
        : h('span', { class: 'mv' });
    rows.push(h('li', null, h('span', { class: 'mv-n' }, `${i / 2 + 1}.`), cell(i), cell(i + 1)));
  }
  replace(moveList, rows.length ? rows : h('li', { class: 'muted' }, 'Nenhum lance.'));

  const nav = (label: string, aria: string, fn: () => void) => h('button', { type: 'button', class: 'btn', 'aria-label': aria, title: aria, onclick: fn }, label);

  replace(
    main,
    h(
      'div',
      { class: 'review' },
      h(
        'div',
        { class: 'game-head' },
        h('div', null,
          h('h1', { class: 'review-title' }, title),
          h('p', { class: 'muted small' }, `${resultText(game.result, game.reason, game.whiteNick, game.blackNick)} · ${game.result} · ${fmtTc(game.tc)} · ${fmtDate(game.endedAt)}`),
        ),
      ),
      h(
        'div',
        { class: 'game-layout' },
        h('div', { class: 'board-box' }, h('div', { class: 'board-wrap' }, boardEl), h('div', { class: 'review-nav' },
          nav('⏮', 'Início', () => show(0)),
          nav('◀', 'Lance anterior', () => show(cursor - 1)),
          nav('▶', 'Próximo lance', () => show(cursor + 1)),
          nav('⏭', 'Fim', () => show(plies.length)),
          nav('⇅', 'Virar tabuleiro', () => {
            orientation = orientation === 'w' ? 'b' : 'w';
            show(cursor);
          }),
        )),
        h(
          'div',
          { class: 'game-side' },
          h('section', { class: 'card' }, counter, moveList),
          h(
            'section',
            { class: 'card' },
            h('h2', null, 'Posição'),
            h('div', { class: 'fen-row' }, fenInput,
              h('button', { type: 'button', class: 'btn btn-small', onclick: async () => toast((await copyText(fenInput.value)) ? 'FEN copiado.' : 'Não consegui copiar.') }, 'Copiar FEN')),
            h('div', { class: 'actions', style: { 'margin-top': '0.8rem' } },
              h('a', { class: 'btn btn-primary', href: `/api/games/${encodeURIComponent(game.id)}/pgn`, download: `xadrez-${game.id}.pgn` }, 'Baixar PGN'),
              h('button', { type: 'button', class: 'btn', onclick: async () => toast((await copyText(game.pgn)) ? 'PGN copiado.' : 'Não consegui copiar.') }, 'Copiar PGN'),
              h('button', { type: 'button', class: 'btn', onclick: async () => toast((await copyText(location.href)) ? 'Link copiado.' : location.href) }, 'Copiar link'),
            ),
          ),
        ),
      ),
    ),
  );

  cg = createBoard(boardEl, { viewOnly: true, fen: game.finalFen, drawable: { enabled: true } });
  show(plies.length);

  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const k: Record<string, () => void> = {
      ArrowLeft: () => show(cursor - 1),
      ArrowRight: () => show(cursor + 1),
      ArrowUp: () => show(0),
      ArrowDown: () => show(plies.length),
      Home: () => show(0),
      End: () => show(plies.length),
    };
    const fn = k[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}

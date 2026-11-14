// Tabuleiro: chessground (o do Lichess) com as regras do chess.js para os lances legais.
import { Chess, type Square } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Color as CgColor, Key } from 'chessground/types';
import type { Color } from '../../shared/protocol.ts';
import { h } from './dom.ts';

export type { Api, Config, Key };

export const cgColor = (c: Color): CgColor => (c === 'w' ? 'white' : 'black');

/** Destinos legais de cada casa, no formato do chessground. */
export function legalDests(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const m of chess.moves({ verbose: true })) {
    const list = dests.get(m.from as Key) ?? [];
    list.push(m.to as Key);
    dests.set(m.from as Key, list);
  }
  return dests;
}

export function lastMoveOf(uci: string | undefined): Key[] | undefined {
  return uci ? [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key] : undefined;
}

/** O lance de `from` para `to` é promoção? */
export function isPromotion(chess: Chess, from: string, to: string): boolean {
  return chess.moves({ square: from as Square, verbose: true }).some((m) => m.to === to && m.promotion);
}

export function createBoard(el: HTMLElement, config: Config): Api {
  return Chessground(el, {
    coordinates: true,
    animation: { enabled: true, duration: 200 },
    highlight: { lastMove: true, check: true },
    draggable: { enabled: true, showGhost: true },
    drawable: { enabled: true },
    ...config,
  });
}

/** Miniatura só de visualização (lobby). */
export function miniBoard(fen: string, orientation: Color = 'w', lastUci?: string): HTMLElement {
  const wrap = h('div', { class: 'mini-board' });
  const inner = h('div', { class: 'cg-wrap' });
  wrap.appendChild(inner);
  // O chessground precisa do elemento na página para medir: espera o próximo quadro.
  requestAnimationFrame(() => {
    Chessground(inner, {
      fen,
      orientation: cgColor(orientation),
      viewOnly: true,
      coordinates: false,
      lastMove: lastMoveOf(lastUci),
      animation: { enabled: false },
      drawable: { enabled: false, visible: false },
    });
  });
  return wrap;
}

const PROMO_ROLES: { role: 'q' | 'r' | 'b' | 'n'; cg: string; label: string }[] = [
  { role: 'q', cg: 'queen', label: 'Dama' },
  { role: 'n', cg: 'knight', label: 'Cavalo' },
  { role: 'r', cg: 'rook', label: 'Torre' },
  { role: 'b', cg: 'bishop', label: 'Bispo' },
];

/** Pergunta a peça da promoção, sobre o tabuleiro. Resolve null se a pessoa desistir. */
export function choosePromotion(boardEl: HTMLElement, color: Color): Promise<'q' | 'r' | 'b' | 'n' | null> {
  return new Promise((resolve) => {
    const done = (r: 'q' | 'r' | 'b' | 'n' | null) => {
      overlay.remove();
      resolve(r);
    };
    const overlay = h(
      'div',
      {
        class: 'promotion',
        role: 'dialog',
        'aria-label': 'Escolha a peça da promoção',
        onclick: (e: Event) => {
          if (e.target === overlay) done(null);
        },
      },
      h(
        'div',
        // cg-wrap: o CSS das peças do chessground só vale dentro dessa classe.
        { class: 'promotion-choices cg-wrap' },
        PROMO_ROLES.map((p) =>
          h(
            'button',
            { class: 'promotion-piece', type: 'button', title: p.label, 'aria-label': p.label, onclick: () => done(p.role) },
            pieceEl(`${p.cg} ${cgColor(color)}`),
          ),
        ),
      ),
    );
    boardEl.appendChild(overlay);
    (overlay.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}

const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/**
 * Desequilíbrio de material, como no Lichess: para cada tipo de peça, quem tem mais mostra a diferença
 * (byWhite: peças pretas "a menos" do outro lado). Conta pelo que está no tabuleiro, então uma promoção
 * aparece como dama a mais, e não como peão perdido. diff > 0: brancas na frente em pontos.
 */
export function captured(fen: string): { byWhite: string[]; byBlack: string[]; diff: number } {
  const count: Record<string, number> = {};
  for (const ch of fen.split(' ')[0] ?? '') if (/[pnbrqPNBRQ]/.test(ch)) count[ch] = (count[ch] ?? 0) + 1;
  const byWhite: string[] = [];
  const byBlack: string[] = [];
  let diff = 0;
  for (const p of ['q', 'r', 'b', 'n', 'p']) {
    const d = (count[p.toUpperCase()] ?? 0) - (count[p] ?? 0);
    for (let i = 0; i < d; i++) byWhite.push(p);
    for (let i = 0; i < -d; i++) byBlack.push(p);
    diff += d * VALUES[p]!;
  }
  return { byWhite, byBlack, diff };
}

const ROLE_NAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };

/** Fileira de peças capturadas (desenhadas com o mesmo conjunto do tabuleiro). */
export function capturedRow(pieces: string[], color: Color, diff: number): HTMLElement {
  return h(
    'div',
    { class: 'captured cg-wrap', 'aria-label': `${pieces.length} peças capturadas` },
    pieces.map((p) => pieceEl(`${ROLE_NAME[p]} ${cgColor(color)}`)),
    diff > 0 ? h('span', { class: 'material' }, `+${diff}`) : null,
  );
}

/** Elemento <piece> do chessground (o CSS do conjunto de peças desenha pela classe). */
function pieceEl(cls: string): HTMLElement {
  const el = document.createElement('piece');
  el.className = cls;
  return el;
}

export { Chess };

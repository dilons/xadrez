// Textos e formatos da interface (pt-BR).
import type { EndReason, Result, TimeControl } from '../../shared/protocol.ts';

export function fmtTc(tc: TimeControl | null): string {
  if (!tc) return 'Sem tempo';
  const base = tc.baseMs / 1000;
  const b = base < 60 ? `${base}s` : base % 60 === 0 ? String(base / 60) : (base / 60).toFixed(1).replace('.', ',');
  return `${b}+${tc.incMs / 1000}`;
}

/** Relógio: 1:05:03, 4:59, 0:09.4 (décimos abaixo de 10 s). */
export function fmtClock(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 10_000) {
    const s = Math.floor(t / 1000);
    const d = Math.floor((t % 1000) / 100);
    return `0:0${s},${d}`;
  }
  const total = Math.ceil(t / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const REASONS: Record<EndReason, string> = {
  checkmate: 'xeque-mate',
  stalemate: 'afogamento',
  repetition: 'tripla repetição',
  'fifty-moves': 'regra dos 50 lances',
  insufficient: 'material insuficiente',
  timeout: 'tempo esgotado',
  'timeout-vs-insufficient': 'tempo esgotado, sem material para mate',
  resign: 'desistência',
  agreement: 'acordo',
  abandon: 'abandono',
  removed: 'jogador removido da sala',
};

export function reasonText(r: EndReason): string {
  return REASONS[r];
}

export function resultText(result: Result, reason: EndReason, whiteNick: string, blackNick: string): string {
  if (result === '1/2-1/2') return `Empate (${reasonText(reason)})`;
  const winner = result === '1-0' ? whiteNick : blackNick;
  return `${winner} venceu (${reasonText(reason)})`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const PIECE_PT: Record<string, string> = { K: 'R', Q: 'D', R: 'T', B: 'B', N: 'C' };

/** Lance em notação algébrica com as iniciais em português (Rei, Dama, Torre, Bispo, Cavalo): Nf3 → Cf3, e8=Q → e8=D.
 *  Só na tela: o PGN continua com as letras inglesas, que é o padrão dos programas de xadrez. */
export function sanPt(san: string): string {
  return san.replace(/[KQRBN]/g, (p) => PIECE_PT[p] ?? p);
}

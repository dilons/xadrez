// Relógio de xadrez, puro: o tempo entra como parâmetro (`now`, em ms), nada de Date.now() aqui dentro.
import type { Color, ClockView, TimeControl } from '../../shared/protocol.ts';

export interface Clock {
  tc: TimeControl;
  /** Tempo restante de cada cor, valendo no instante `since` para a cor que está correndo. */
  remaining: { w: number; b: number };
  running: Color | null;
  /** Quando o relógio da cor `running` começou a correr. */
  since: number;
}

export function createClock(tc: TimeControl): Clock {
  return { tc, remaining: { w: tc.baseMs, b: tc.baseMs }, running: null, since: 0 };
}

export function other(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

/** Tempo restante de uma cor agora (pode ser negativo se já estourou e ninguém conferiu). */
export function remainingAt(clock: Clock, color: Color, now: number): number {
  const base = clock.remaining[color];
  return clock.running === color ? base - Math.max(0, now - clock.since) : base;
}

/** Começa a correr o relógio de `color` (sem mexer no tempo de ninguém). */
export function start(clock: Clock, color: Color, now: number): void {
  if (clock.running) clock.remaining[clock.running] = remainingAt(clock, clock.running, now);
  clock.running = color;
  clock.since = now;
}

/** Para o relógio, congelando o tempo de quem estava correndo. */
export function stop(clock: Clock, now: number): void {
  if (!clock.running) return;
  clock.remaining[clock.running] = remainingAt(clock, clock.running, now);
  clock.running = null;
}

/**
 * `color` terminou o lance: desconta o tempo gasto, soma o incremento e passa a vez.
 * Devolve `false` (sem mexer em nada) se o tempo de `color` já tinha acabado: quem chama decide a derrota.
 */
export function press(clock: Clock, color: Color, now: number, startOther = true): boolean {
  if (clock.running === color) {
    const left = remainingAt(clock, color, now);
    if (left <= 0) return false;
    clock.remaining[color] = left + clock.tc.incMs;
  }
  // Primeiro lance de cada cor (relógio parado): não desconta nada nem soma incremento.
  clock.running = null;
  if (startOther) start(clock, other(color), now);
  return true;
}

/** Cor cujo tempo acabou, se alguma. */
export function flagged(clock: Clock, now: number): Color | null {
  if (clock.running && remainingAt(clock, clock.running, now) <= 0) return clock.running;
  return null;
}

/** Milissegundos até o relógio que está correndo estourar (null: parado). */
export function msUntilFlag(clock: Clock, now: number): number | null {
  if (!clock.running) return null;
  return Math.max(0, remainingAt(clock, clock.running, now));
}

/** Fixa o tempo em zero para quem estourou (para a vista e o PGN não mostrarem números negativos). */
export function settleFlag(clock: Clock, color: Color): void {
  clock.remaining[color] = 0;
  clock.running = null;
}

export function view(clock: Clock, now: number): ClockView {
  return {
    whiteMs: Math.max(0, Math.round(remainingAt(clock, 'w', now))),
    blackMs: Math.max(0, Math.round(remainingAt(clock, 'b', now))),
    running: clock.running,
  };
}

/** Depois de um restart: o tempo em que o servidor ficou fora do ar não conta para ninguém. */
export function resumeAfterDowntime(clock: Clock, now: number): void {
  if (clock.running) clock.since = now;
}

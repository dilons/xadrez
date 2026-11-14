// Sons curtos sintetizados (WebAudio): nenhum arquivo de áudio, nenhuma licença a mais. Liga e desliga em prefs.
import { prefs } from './storage.ts';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (!prefs.sound()) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, ms: number, type: OscillatorType = 'sine', gain = 0.15, delay = 0): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay / 1000;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

export const sound = {
  move: () => tone(520, 70, 'triangle', 0.18),
  capture: () => {
    tone(300, 90, 'square', 0.08);
    tone(200, 120, 'triangle', 0.15, 30);
  },
  check: () => {
    tone(880, 90, 'triangle', 0.15);
    tone(660, 120, 'triangle', 0.12, 90);
  },
  start: () => {
    tone(440, 100);
    tone(660, 160, 'sine', 0.15, 110);
  },
  end: () => {
    tone(660, 140);
    tone(523, 140, 'sine', 0.15, 150);
    tone(392, 260, 'sine', 0.15, 300);
  },
  lowTime: () => tone(1200, 60, 'square', 0.05),
  notify: () => tone(990, 80, 'sine', 0.1),
};

/** Toca o som certo para um lance pelo SAN (x captura, + xeque, # mate). */
export function moveSound(san: string): void {
  if (san.includes('+') || san.includes('#')) sound.check();
  else if (san.includes('x')) sound.capture();
  else sound.move();
}

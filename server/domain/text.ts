// Limpeza de texto de usuário (apelidos e chat). O front ainda escapa tudo ao mostrar (textContent);
// aqui saem caracteres de controle e invisíveis, para ninguém se passar por outro com um apelido "igual".
import { LIMITS } from '../../shared/protocol.ts';

/** Controle, formatação (zero-width, bidi), substitutos soltos e uso privado. O ZWJ fica: ele junta emojis (👨\u200D👩\u200D👧). */
const INVISIBLE = /(?!\u200D)[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu;

export function cleanLine(s: string): string {
  return s.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/gu, ' ').trim();
}

export function length(s: string): number {
  return [...s].length;
}

/** Apelido limpo, ou null se ficar vazio ou longo demais. */
export function cleanNick(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const s = cleanLine(raw);
  const n = length(s);
  if (n < LIMITS.nickMin || n > LIMITS.nickMax) return null;
  return s;
}

/** Chave para comparar apelidos: sem maiúsculas, acentos nem espaços ("José" = "jose" = "J o s é"). */
export function nickKey(nick: string): string {
  return nick.normalize('NFD').replace(/[\p{M}\u200D]/gu, '').toLocaleLowerCase('pt-BR').replace(/\s/gu, '');
}

export function cleanChat(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > LIMITS.chatMax * 4) return null;
  const s = cleanLine(raw);
  const n = length(s);
  if (n < 1 || n > LIMITS.chatMax) return null;
  return s;
}

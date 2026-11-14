// localStorage com try/catch (aba anônima, armazenamento bloqueado): sem ele o app funciona, só não lembra.

const PREFIX = 'xadrez:';

function get<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function set(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
}

export interface Identity {
  id: string;
  secret: string;
  nick: string;
}

/** Identidade numa sala (id aleatório + segredo): com ela a pessoa reconecta no mesmo lugar. */
export const identity = {
  get: (room: string) => get<Identity>(`sala:${room}`),
  set: (room: string, v: Identity | null) => set(`sala:${room}`, v),
};

/** Chave de criador, recebida ao criar a sala e usada só na primeira entrada. */
export const creatorKey = {
  get: (room: string) => get<string>(`criador:${room}`),
  set: (room: string, v: string | null) => set(`criador:${room}`, v),
};

export const lastNick = {
  get: () => get<string>('apelido') ?? '',
  set: (v: string) => set('apelido', v),
};

export interface RecentRoom {
  code: string;
  at: number;
}

export const recentRooms = {
  get: () => get<RecentRoom[]>('recentes') ?? [],
  add(code: string) {
    const list = this.get().filter((r) => r.code !== code);
    list.unshift({ code, at: Date.now() });
    set('recentes', list.slice(0, 8));
  },
  remove(code: string) {
    set(
      'recentes',
      this.get().filter((r) => r.code !== code),
    );
  },
};

export const prefs = {
  sound: () => get<boolean>('som') ?? true,
  setSound: (v: boolean) => set('som', v),
};

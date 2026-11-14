// Stockfish no navegador: o build "lite, single-threaded" (WebAssembly) roda num Web Worker e conversa por UCI.
// Thread única: não precisa de SharedArrayBuffer nem dos cabeçalhos COOP/COEP.
// Os arquivos são copiados de node_modules/stockfish para /stockfish/ pelo vite.config.ts.

export const ENGINE_URL = '/stockfish/stockfish-19-lite-single.js';

export interface Level {
  label: string;
  skill: number;
  depth: number;
  movetime: number;
}

/** Oito níveis, do iniciante ao mais forte que o navegador aguenta sem travar. */
export const LEVELS: Level[] = [
  { label: '1 · Iniciante', skill: 0, depth: 1, movetime: 50 },
  { label: '2', skill: 3, depth: 2, movetime: 100 },
  { label: '3', skill: 6, depth: 4, movetime: 150 },
  { label: '4', skill: 9, depth: 6, movetime: 250 },
  { label: '5', skill: 12, depth: 8, movetime: 400 },
  { label: '6', skill: 15, depth: 11, movetime: 600 },
  { label: '7', skill: 18, depth: 14, movetime: 900 },
  { label: '8 · Máximo', skill: 20, depth: 22, movetime: 1500 },
];

export class Engine {
  private worker: Worker;
  private listeners = new Set<(line: string) => void>();
  private ready: Promise<void>;

  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const l of this.listeners) l(line);
    };
    this.ready = (async () => {
      this.send('uci');
      await this.waitFor((l) => l === 'uciok', 20_000);
      this.send('isready');
      await this.waitFor((l) => l === 'readyok', 20_000);
    })();
  }

  private send(cmd: string): void {
    this.worker.postMessage(cmd);
  }

  private waitFor(pred: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error('o motor não respondeu'));
      }, timeoutMs);
      const fn = (line: string) => {
        if (!pred(line)) return;
        clearTimeout(timer);
        this.listeners.delete(fn);
        resolve(line);
      };
      this.listeners.add(fn);
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  newGame(): void {
    this.send('ucinewgame');
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Melhor lance (UCI) para a posição, no nível pedido. As buscas vão em fila: cada `bestmove` responde à busca
   * que está rodando. Para cancelar, `stop()` encerra a busca atual (quem chamou descarta o resultado).
   */
  bestMove(fen: string, level: Level): Promise<string | null> {
    const run = async () => {
      await this.ready;
      this.send(`setoption name Skill Level value ${level.skill}`);
      this.send(`position fen ${fen}`);
      this.send(`go depth ${level.depth} movetime ${level.movetime}`);
      const line = await this.waitFor((l) => l.startsWith('bestmove'), level.movetime + 30_000);
      const mv = line.split(/\s+/)[1];
      return mv && mv !== '(none)' ? mv : null;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  stop(): void {
    this.send('stop');
  }

  destroy(): void {
    this.worker.terminate();
    this.listeners.clear();
  }
}

// Front: Vite com TypeScript, sem framework. Em dev (npm run dev:web), o Vite repassa /api e /ws ao servidor na 3000.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const backend = process.env.BACKEND ?? 'http://127.0.0.1:3000';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * O Stockfish (build "lite, single-threaded", GPL-3.0) vai como arquivo estático em /stockfish/, com a licença:
 * o worker carrega o .js, que busca o .wasm ao lado. Copiado de node_modules a cada dev/build (fora do Git).
 */
function stockfish(): Plugin {
  return {
    name: 'copy-stockfish',
    buildStart() {
      const from = join(here, 'node_modules', 'stockfish');
      const to = join(here, 'web', 'public', 'stockfish');
      mkdirSync(to, { recursive: true });
      for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) copyFileSync(join(from, 'bin', f), join(to, f));
      copyFileSync(join(from, 'Copying.txt'), join(to, 'COPYING.txt'));
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [stockfish()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 600 },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/healthz': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});

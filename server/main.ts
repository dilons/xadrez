// Ponto de entrada: um processo serve o front, a API e o WebSocket. Estado ao vivo na memória, snapshot no SQLite.
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

// O node:sqlite ainda avisa que é experimental; o aviso não ajuda em produção.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.warn(w);
});

const cfg = loadConfig();
const app = createApp(cfg);

app.server.listen(cfg.port, cfg.host, () => {
  console.log(`xadrez ouvindo em http://${cfg.host}:${cfg.port} (${app.restored} salas recuperadas de ${cfg.dbPath})`);
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: encerrando`);
  setTimeout(() => process.exit(0), 5000).unref();
  void app.close().then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

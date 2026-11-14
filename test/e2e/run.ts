// Teste de navegador (Playwright): dois navegadores entram na mesma sala e jogam até o mate, e um terceiro assiste.
// Fora do `npm test`. Precisa do front gerado (npm run build) e do playwright-core, que não fica no package.json:
//
//   npm install --no-save playwright-core@1.65.1 && npx playwright-core install chromium
//   npm run test:e2e -- [pasta-dos-screenshots]
//
// Outro navegador: CHROME_PATH=/caminho/do/chrome, ou BROWSER_CHANNEL=msedge|chrome (o instalado na máquina).
// Sai com código 1 se algo falhar.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../server/app.ts';
import { testConfig } from '../server-helpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Browser = any;

const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'xadrez-e2e-'));
// Tolerância de desconexão de 5 s (o padrão é 60), para o passo de abandono não demorar.
const cfg = testConfig(dir, { webDir: resolve('web/dist'), roomsPerIpPerHour: 50, connectionsPerIp: 50, graceMs: 5_000 });
const app = createApp(cfg);
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const pw = (await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')) as any;
const chromium = pw.chromium ?? pw.default?.chromium;
const browser: Browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
});

let failed = false;
const step = async (name: string, fn: () => Promise<void>) => {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed = true;
    console.error(`FALHA ${name}: ${(e as Error).stack ?? e}`);
    throw e;
  }
};

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
}

/** Cada pessoa num contexto próprio (localStorage separado = identidade separada). */
async function person(viewport = { width: 1100, height: 820 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => {
    failed = true;
    console.error(`erro na página: ${e.message}`);
  });
  page.on('console', (m: any) => {
    if (m.type() === 'error') {
      failed = true;
      console.error(`console: ${m.text()}`);
    }
  });
  return page;
}

async function enter(page: Page, nick: string): Promise<void> {
  await page.getByPlaceholder('Seu apelido').fill(nick);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('heading', { name: 'Na sala' }).waitFor();
}

/** Clica numa casa do tabuleiro, levando em conta a orientação. */
async function clickSquare(page: Page, sq: string, orientation: 'white' | 'black'): Promise<void> {
  const box = await page.locator('.board-wrap cg-board').boundingBox();
  if (!box) throw new Error('tabuleiro não encontrado');
  const size = box.width / 8;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]);
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;
  await page.mouse.click(box.x + (col + 0.5) * size, box.y + (row + 0.5) * size);
}

async function movesShown(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    // Roda dentro da página (por isso o globalThis: este arquivo é checado sem os tipos do DOM).
    (k: number) => (globalThis as any).document.querySelectorAll('.game-side .move-list .mv:not(:empty)').length >= k,
    n,
    { timeout: 10_000 },
  );
}

async function play(page: Page, uci: string, orientation: 'white' | 'black', plyAfter: number): Promise<void> {
  await clickSquare(page, uci.slice(0, 2), orientation);
  await clickSquare(page, uci.slice(2, 4), orientation);
  await movesShown(page, plyAfter);
}

try {
  const ana = await person();
  const bia = await person({ width: 390, height: 844 }); // celular
  const caio = await person();
  let roomUrl = '';

  await step('Ana cria a sala e entra como criadora', async () => {
    await ana.goto(base);
    await ana.getByRole('button', { name: 'Criar sala' }).click();
    await ana.waitForURL(/\/s\/[a-z0-9]+$/);
    roomUrl = ana.url();
    await enter(ana, 'Ana');
    await ana.locator('.person', { hasText: 'Ana' }).locator('.badge', { hasText: 'criador' }).waitFor();
    await shot(ana, '01-lobby');
  });

  await step('Bia (celular) e Caio entram pelo link; a presença aparece para todos', async () => {
    await bia.goto(roomUrl);
    await enter(bia, 'Bia');
    await caio.goto(roomUrl);
    await enter(caio, 'Caio');
    await ana.locator('.person', { hasText: 'Bia' }).locator('.dot-on').waitFor();
    await ana.locator('.person', { hasText: 'Caio' }).locator('.dot-on').waitFor();
  });

  await step('Ana abre uma mesa de brancas e Bia senta', async () => {
    await ana.locator('.chip', { hasText: 'Brancas' }).click();
    await ana.getByRole('button', { name: 'Abrir mesa' }).click();
    await bia.getByRole('button', { name: 'Sentar' }).click();
    await ana.waitForURL(/#m=/);
    await bia.waitForURL(/#m=/);
    await ana.locator('.game-title', { hasText: 'Ana × Bia' }).waitFor();
    await shot(bia, '02-mesa-celular');
  });

  await step('Caio assiste pela miniatura do lobby', async () => {
    await caio.locator('.game-card').first().click();
    await caio.locator('.game-title', { hasText: 'Ana × Bia' }).waitFor();
  });

  await step('mate do louco: 1.f3 e5 2.g4 Dh4#', async () => {
    await play(ana, 'f2f3', 'white', 1);
    await movesShown(bia, 1);
    await play(bia, 'e7e5', 'black', 2);
    await movesShown(ana, 2);
    await play(ana, 'g2g4', 'white', 3);
    await movesShown(bia, 3);
    await play(bia, 'd8h4', 'black', 4);
    for (const p of [ana, bia, caio]) await p.locator('.game-status', { hasText: 'Bia venceu (xeque-mate)' }).waitFor();
    await shot(ana, '03-mate');
    await shot(caio, '04-espectador');
  });

  await step('chat da partida chega escapado', async () => {
    await caio.locator('.game-side .chat-input').fill('<img src=x onerror=alert(1)> boa!');
    await caio.locator('.game-side .chat-input').press('Enter');
    const msg = ana.locator('.game-side .chat-text', { hasText: 'boa!' });
    await msg.waitFor();
    if ((await msg.textContent())?.includes('<img') !== true) throw new Error('o texto deveria aparecer literal');
    if ((await ana.locator('.game-side .chat-list img').count()) !== 0) throw new Error('virou HTML');
  });

  await step('revisão /p/<id>: lances, FEN e PGN', async () => {
    const href = await ana.getByRole('link', { name: 'Rever a partida' }).getAttribute('href');
    const review = await person();
    await review.goto(base + href);
    await review.locator('.review-moves', { hasText: 'Dh4#' }).waitFor();
    await review.keyboard.press('Home');
    const fen = await review.locator('input.fen').inputValue();
    if (!fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w')) throw new Error(`FEN inicial errado: ${fen}`);
    const pgn = await (await fetch(`${base}/api${href!.replace('/p/', '/games/')}/pgn`)).text();
    if (!/1\. f3 e5 2\. g4 Qh4# 0-1/.test(pgn)) throw new Error(`PGN inesperado: ${pgn}`);
    await shot(review, '05-revisao');
  });

  await step('revanche: as cores trocam', async () => {
    await bia.getByRole('button', { name: 'Revanche' }).click();
    await ana.getByRole('button', { name: 'Aceitar' }).click();
    await ana.locator('.game-title', { hasText: 'Bia × Ana' }).waitFor();
    await bia.locator('.game-title', { hasText: 'Bia × Ana' }).waitFor();
  });

  await step('recarregar a página volta para a mesma mesa', async () => {
    await bia.reload();
    await bia.locator('.game-title', { hasText: 'Bia × Ana' }).waitFor();
    await bia.locator('.conn-status[data-status="open"]').waitFor({ state: 'attached' });
  });

  await step('pré-lance: Ana (pretas) marca e5 antes da vez e ele sai sozinho depois de 1.e4', async () => {
    await clickSquare(ana, 'e7', 'black');
    await clickSquare(ana, 'e5', 'black');
    await play(bia, 'e2e4', 'white', 1);
    await movesShown(ana, 2);
    await movesShown(bia, 2);
    const text = await bia.locator('.game-side .move-list').innerText();
    if (!/e4\s+e5/.test(text)) throw new Error(`lances inesperados: ${text}`);
  });

  await step('voltar lance: Bia pede depois de 2.Cf3, Ana aceita', async () => {
    await play(bia, 'g1f3', 'white', 3);
    await movesShown(ana, 3);
    await bia.getByRole('button', { name: 'Voltar lance' }).click();
    await ana.locator('.banner', { hasText: 'pede para voltar o lance' }).getByRole('button', { name: 'Aceitar' }).click();
    await bia.waitForFunction(
      () => (globalThis as any).document.querySelectorAll('.game-side .move-list .mv:not(:empty)').length === 2,
      undefined,
      { timeout: 10_000 },
    );
  });

  await step('empate por acordo', async () => {
    await ana.getByRole('button', { name: 'Propor empate' }).click();
    await bia.locator('.banner', { hasText: 'propõe empate' }).getByRole('button', { name: 'Aceitar' }).click();
    for (const p of [ana, bia, caio]) await p.locator('.game-status', { hasText: 'Empate (acordo)' }).waitFor();
    await shot(bia, '06-empate-celular');
  });

  /** Fecha a mesa terminada e abre outra (Ana de brancas), com Bia sentando. */
  async function newTable(tc: { chip: string; minutes?: string; inc?: string }): Promise<void> {
    await ana.getByRole('button', { name: 'Sair da mesa' }).click();
    await ana.getByRole('heading', { name: 'Abrir uma mesa' }).waitFor();
    await bia.getByRole('heading', { name: 'Abrir uma mesa' }).waitFor();
    await ana.locator('.chip', { hasText: tc.chip }).click();
    if (tc.minutes !== undefined) {
      await ana.getByLabel('Minutos').fill(tc.minutes);
      await ana.getByLabel('Incremento em segundos').fill(tc.inc ?? '0');
    }
    await ana.locator('.chip', { hasText: 'Brancas' }).click();
    await ana.getByRole('button', { name: 'Abrir mesa' }).click();
    await bia.getByRole('button', { name: 'Sentar' }).click();
    await ana.locator('.game-title', { hasText: 'Ana × Bia' }).waitFor();
    await bia.locator('.game-title', { hasText: 'Ana × Bia' }).waitFor();
  }

  await step('promoção: a janela pede a peça e 5.bxa8=D vira dama', async () => {
    await newTable({ chip: 'Sem tempo' });
    const line = ['e2e4', 'd7d5', 'e4d5', 'c7c6', 'd5c6', 'g8f6', 'c6b7', 'b8d7'];
    for (const [i, uci] of line.entries()) {
      const white = i % 2 === 0;
      await play(white ? ana : bia, uci, white ? 'white' : 'black', i + 1);
      await movesShown(white ? bia : ana, i + 1);
    }
    await clickSquare(ana, 'b7', 'white');
    await clickSquare(ana, 'a8', 'white');
    const dialog = ana.getByRole('dialog', { name: 'Escolha a peça da promoção' });
    await dialog.waitFor();
    await shot(ana, '07-promocao-escolha');
    await dialog.getByRole('button', { name: 'Dama' }).click();
    await movesShown(bia, 9);
    for (const p of [ana, bia]) await p.locator('.game-side .move-list .mv', { hasText: 'bxa8=D' }).waitFor();
    const fen = await (await fetch(`${base}/healthz`)).ok; // o servidor continua de pé
    if (!fen) throw new Error('servidor caiu');
    if ((await ana.locator('cg-board piece.queen.white').count()) !== 2) throw new Error('esperava duas damas brancas');
    await shot(bia, '08-promocao-celular');
    ana.once('dialog', (d: any) => d.accept());
    await ana.getByRole('button', { name: 'Desistir' }).click();
    await ana.locator('.game-status', { hasText: 'Bia venceu (desistência)' }).waitFor();
  });

  await step('derrota por tempo: relógio de 15 s estoura e o servidor encerra', async () => {
    await newTable({ chip: 'Personalizado', minutes: '0.25', inc: '0' });
    await ana.locator('.game-title', { hasText: '15s+0' }).waitFor();
    await play(ana, 'e2e4', 'white', 1);
    await movesShown(bia, 1);
    await play(bia, 'e7e5', 'black', 2);
    // Agora o relógio da Ana corre (começa depois do 1º lance de cada lado). Ninguém joga.
    await ana.locator('.clock.clock-running.clock-low').waitFor({ timeout: 15_000 });
    await shot(ana, '09-tempo-acabando');
    for (const p of [ana, bia]) await p.locator('.game-status', { hasText: 'Bia venceu (tempo esgotado)' }).waitFor({ timeout: 20_000 });
    // Caio voltou ao lobby quando a mesa que ele assistia fechou: lá a partida aparece entre as terminadas.
    await caio.locator('.finished-list li', { hasText: 'Bia venceu (tempo esgotado)' }).waitFor();
    const clocks = await ana.locator('.player-bar .clock').allInnerTexts();
    if (!clocks.some((c: string) => c.startsWith('0:00'))) throw new Error(`relógio da Ana deveria estar zerado: ${clocks}`);
    await shot(ana, '10-tempo-esgotado');
  });

  await step('abandono: Bia fecha o navegador; depois da tolerância, Ana reivindica a vitória', async () => {
    await newTable({ chip: 'Sem tempo' });
    await play(ana, 'd2d4', 'white', 1);
    await movesShown(bia, 1);
    await play(bia, 'd7d5', 'black', 2);
    await movesShown(ana, 2);
    await bia.context().close();
    await ana.locator('.player-bar', { hasText: 'Bia · desconectado' }).waitFor();
    await ana.locator('.banner', { hasText: 'Bia desconectou. Se não voltar em' }).waitFor();
    // Antes do prazo, o botão não aparece.
    if ((await ana.getByRole('button', { name: 'Reivindicar vitória' }).count()) !== 0) throw new Error('botão antes da hora');
    await shot(ana, '11-abandono-contagem');
    await ana.getByRole('button', { name: 'Reivindicar vitória' }).click({ timeout: 15_000 });
    await ana.locator('.game-status', { hasText: 'Ana venceu (abandono)' }).waitFor();
    await caio.locator('.finished-list li', { hasText: 'Ana venceu (abandono)' }).waitFor();
    await shot(ana, '12-abandono-vitoria');
  });

  await step('remoção: a criadora remove Caio; ele cai da sala e o segredo dele deixa de valer', async () => {
    // A identidade do Caio, para tentar voltar com ela depois da remoção.
    const saved = await caio.evaluate(() => JSON.stringify(Object.entries((globalThis as any).localStorage)));
    await ana.getByRole('button', { name: 'Sair da mesa' }).click();
    await ana.getByRole('heading', { name: 'Na sala' }).waitFor();
    const row = ana.locator('.person', { hasText: 'Caio' });
    if ((await caio.locator('.person', { hasText: 'Ana' }).getByRole('button', { name: 'Remover' }).count()) !== 0)
      throw new Error('quem não é criador não deveria ver o botão Remover');
    ana.once('dialog', (d: any) => d.accept());
    await row.getByRole('button', { name: 'Remover' }).click();
    await caio.getByRole('heading', { name: 'Você saiu da sala' }).waitFor();
    await caio.getByText('O criador da sala removeu você.').waitFor();
    await row.waitFor({ state: 'detached' });
    await shot(caio, '13-removido');
    // Mesmo pondo de volta o id e o segredo antigos, o servidor recusa.
    await caio.evaluate((json: string) => {
      for (const [k, v] of JSON.parse(json) as [string, string][]) (globalThis as any).localStorage.setItem(k, v);
    }, saved);
    await caio.reload();
    await caio.getByRole('heading', { name: 'Você saiu da sala' }).waitFor();
  });

  await step('bot no nível 8 (celular): o Stockfish carrega no worker e responde em até ~1,5 s', async () => {
    const me = await person({ width: 390, height: 844 });
    await me.goto(`${base}/bot`);
    // Pelo valor: o rótulo "7" é de outra opção (nível 7), e o selectOption com texto também compara rótulos.
    await me.getByLabel('Nível').selectOption({ value: '7' });
    await me.getByLabel('Sua cor').selectOption({ value: 'w' });
    await me.getByRole('button', { name: 'Nova partida' }).click();
    const t0 = Date.now();
    await clickSquare(me, 'e2', 'white');
    await clickSquare(me, 'e4', 'white');
    await me.waitForFunction(
      () => JSON.parse((globalThis as any).localStorage.getItem('xadrez:bot') ?? '{"moves":[]}').moves.length >= 2,
      undefined,
      { timeout: 20_000 },
    );
    console.log(`     o bot respondeu em ${Date.now() - t0} ms`);
    await me.locator('.game-status', { hasText: 'Sua vez.' }).waitFor();
    await shot(me, '14-bot-nivel-8');
  });
} catch {
  failed = true;
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error('e2e: FALHOU');
  process.exit(1);
}
console.log('e2e: tudo certo');

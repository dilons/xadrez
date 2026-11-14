import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Chess } from 'chess.js';
import * as clk from '../server/domain/clock.ts';
import * as G from '../server/domain/game.ts';

const T0 = 1_700_000_000_000;

function game(tc: { baseMs: number; incMs: number } | null = null) {
  return G.createGame({ id: 'jogo000001', white: 'W', black: 'B', whiteNick: 'Ana', blackNick: 'Bia', tc, now: T0 });
}

/** Joga lances alternando W e B, a 1 s cada; devolve o instante final. */
function playAll(g: G.Game, ucis: string[], start = T0, step = 1000): number {
  let now = start;
  for (const uci of ucis) {
    now += step;
    const who = g.chess.turn() === 'w' ? 'W' : 'B';
    const o = G.applyMove(g, who, g.moves.length, uci, now);
    assert.equal(o.error, undefined, `${uci}: ${o.error}`);
  }
  return now;
}

describe('relógio', () => {
  test('desconta o tempo de quem joga, soma o incremento e passa a vez', () => {
    const c = clk.createClock({ baseMs: 60_000, incMs: 2_000 });
    clk.start(c, 'w', 0);
    assert.equal(clk.remainingAt(c, 'w', 10_000), 50_000);
    assert.equal(clk.press(c, 'w', 10_000), true);
    assert.equal(c.remaining.w, 52_000);
    assert.equal(c.running, 'b');
    assert.equal(clk.remainingAt(c, 'b', 15_000), 55_000);
    assert.equal(clk.flagged(c, 70_000), 'b');
    assert.equal(clk.msUntilFlag(c, 20_000), 50_000);
  });

  test('não aceita lance com o tempo já esgotado', () => {
    const c = clk.createClock({ baseMs: 1_000, incMs: 5_000 });
    clk.start(c, 'w', 0);
    assert.equal(clk.press(c, 'w', 1_000), false);
    assert.equal(c.running, 'w');
  });

  test('o tempo em que o servidor ficou fora do ar não conta', () => {
    const c = clk.createClock({ baseMs: 60_000, incMs: 0 });
    clk.start(c, 'b', 0);
    const before = clk.remainingAt(c, 'b', 5_000);
    clk.stop(c, 5_000);
    clk.start(c, 'b', 5_000);
    clk.resumeAfterDowntime(c, 500_000);
    assert.equal(clk.remainingAt(c, 'b', 500_000), before);
  });
});

describe('partida: regras', () => {
  test('mate do pastor: xeque-mate encerra com vitória', () => {
    const g = game();
    playAll(g, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
    assert.equal(g.result, '1-0');
    assert.equal(g.reason, 'checkmate');
    assert.equal(G.applyMove(g, 'B', 7, 'e8e7', T0 + 99_000).error, 'game-over');
  });

  test('confere vez, sequência, legalidade e jogador', () => {
    const g = game();
    assert.equal(G.applyMove(g, 'B', 0, 'e7e5', T0).error, 'not-your-turn');
    assert.equal(G.applyMove(g, 'X', 0, 'e2e4', T0).error, 'forbidden');
    assert.equal(G.applyMove(g, 'W', 0, 'e2e5', T0).error, 'illegal-move');
    assert.equal(G.applyMove(g, 'W', 0, 'e1e2', T0).error, 'illegal-move');
    assert.equal(G.applyMove(g, 'W', 0, 'e2e4', T0).moved?.san, 'e4');
    // Repetido (mesmo seq) e fora de ordem são recusados.
    assert.equal(G.applyMove(g, 'W', 0, 'd2d4', T0).error, 'stale-move');
    assert.equal(G.applyMove(g, 'B', 5, 'e7e5', T0).error, 'stale-move');
  });

  test('roque, en passant e promoção com escolha da peça', () => {
    const g = game();
    playAll(g, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
    assert.equal(g.sans.at(-1), 'exd6');
    assert.equal(g.chess.get('d5'), undefined);
    playAll(g, ['a6a5', 'g1f3', 'a5a4', 'f1e2', 'a4a3', 'e1g1'], T0 + 10_000);
    assert.equal(g.sans.at(-1), 'O-O');
    playAll(g, ['b7b6', 'd6c7', 'b6b5'], T0 + 30_000);
    // Promoção sem escolher a peça é ilegal; com a escolha, vale (aqui, cavalo, capturando em b8).
    assert.equal(G.applyMove(g, 'W', g.moves.length, 'c7b8', T0 + 40_000).error, 'illegal-move');
    assert.equal(G.applyMove(g, 'W', g.moves.length, 'c7b8n', T0 + 40_000).moved?.san, 'cxb8=N');
  });

  test('afogamento empata', () => {
    const g = game();
    g.chess = new Chess('k7/8/8/2Q5/8/8/8/7K w - - 0 1');
    assert.equal(G.applyMove(g, 'W', 0, 'h1g2', T0).moved?.san, 'Kg2');
    assert.equal(g.result, null, 'com uma casa livre (b8), não é afogamento');
    const g2 = game();
    g2.chess = new Chess('k7/8/8/2Q5/8/8/8/7K w - - 0 1');
    G.applyMove(g2, 'W', 0, 'c5b6', T0);
    assert.equal(g2.result, '1/2-1/2');
    assert.equal(g2.reason, 'stalemate');
  });

  test('tripla repetição empata', () => {
    const g = game();
    playAll(g, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    assert.equal(g.result, '1/2-1/2');
    assert.equal(g.reason, 'repetition');
  });

  test('regra dos 50 lances empata', () => {
    const g = game();
    g.chess = new Chess('k7/8/8/8/8/8/R7/7K w - - 99 80');
    G.applyMove(g, 'W', 0, 'a2b2', T0);
    assert.equal(g.result, '1/2-1/2');
    assert.equal(g.reason, 'fifty-moves');
  });

  test('material insuficiente empata', () => {
    const g = game();
    g.chess = new Chess('k7/8/8/8/8/8/1n6/K7 w - - 0 1');
    G.applyMove(g, 'W', 0, 'a1b2', T0);
    assert.equal(g.result, '1/2-1/2');
    assert.equal(g.reason, 'insufficient');
  });
});

describe('partida: relógio, desistência, empate e volta', () => {
  test('o relógio só começa depois do primeiro lance de cada lado', () => {
    const g = game({ baseMs: 60_000, incMs: 0 });
    playAll(g, ['e2e4'], T0, 30_000);
    assert.equal(g.clock!.running, null);
    playAll(g, ['e7e5'], T0 + 30_000, 30_000);
    assert.equal(g.clock!.running, 'w');
    assert.equal(g.clock!.remaining.w, 60_000);
    assert.equal(g.clock!.remaining.b, 60_000);
  });

  test('derrota por tempo; empate se quem sobrou não tem material para mate', () => {
    const g = game({ baseMs: 60_000, incMs: 0 });
    const t = playAll(g, ['e2e4', 'e7e5']);
    assert.equal(G.checkTimeout(g, t + 59_000), false);
    assert.equal(G.checkTimeout(g, t + 60_001), true);
    assert.equal(g.result, '0-1');
    assert.equal(g.reason, 'timeout');
    assert.equal(g.clock!.remaining.w, 0);

    const h = game({ baseMs: 60_000, incMs: 0 });
    const t2 = playAll(h, ['e2e4', 'e7e5']);
    h.chess = new Chess('k7/8/8/8/8/8/8/K6R w - - 0 1'); // brancas estouram; pretas só têm o rei
    assert.equal(G.checkTimeout(h, t2 + 61_000), true);
    assert.equal(h.result, '1/2-1/2');
    assert.equal(h.reason, 'timeout-vs-insufficient');
  });

  test('lance com o tempo esgotado perde, mesmo antes do timer do servidor', () => {
    const g = game({ baseMs: 10_000, incMs: 0 });
    const t = playAll(g, ['e2e4', 'e7e5']);
    const o = G.applyMove(g, 'W', 2, 'g1f3', t + 11_000);
    assert.equal(o.error, 'game-over');
    assert.equal(o.ended, true);
    assert.equal(g.result, '0-1');
  });

  test('canMate: só rei, rei e peça menor contra rei, e bispos da mesma cor não dão mate', () => {
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/8/8/K7 w - - 0 1'), 'w'), false);
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/8/8/KN6 w - - 0 1'), 'w'), false);
    assert.equal(G.canMate(new Chess('k7/p7/8/8/8/8/8/KN6 w - - 0 1'), 'w'), true);
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/8/8/KNN5 w - - 0 1'), 'w'), true);
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/8/1B6/KB6 w - - 0 1'), 'w'), true);
    // Com material do outro lado, há mate de ajuda: rei e cavalo contra rei e torre ainda ganham por tempo.
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/8/1n6/K6R w - - 0 1'), 'b'), true);
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/1B6/2B5/K7 w - - 0 1'), 'w'), false);
    assert.equal(G.canMate(new Chess('k7/8/8/8/8/8/7P/K7 w - - 0 1'), 'w'), true);
  });

  test('desistência', () => {
    const g = game();
    assert.equal(G.resign(g, 'X', T0).error, 'forbidden');
    assert.equal(G.resign(g, 'B', T0).ended, true);
    assert.equal(g.result, '1-0');
    assert.equal(g.reason, 'resign');
  });

  test('empate: propor, aceitar, recusar; a oferta cai quando o outro joga', () => {
    const g = game();
    assert.equal(G.draw(g, 'W', 'accept', T0).error, 'not-allowed');
    G.draw(g, 'W', 'offer', T0);
    assert.equal(g.drawOffer, 'w');
    assert.equal(G.draw(g, 'W', 'accept', T0).error, 'not-allowed');
    G.draw(g, 'B', 'decline', T0);
    assert.equal(g.drawOffer, null);
    G.draw(g, 'W', 'offer', T0);
    playAll(g, ['e2e4']);
    assert.equal(g.drawOffer, 'w', 'a oferta continua depois do lance de quem ofereceu');
    playAll(g, ['e7e5'], T0 + 1000);
    assert.equal(g.drawOffer, null, 'o lance do adversário recusa');
    G.draw(g, 'B', 'offer', T0);
    G.draw(g, 'W', 'offer', T0); // propor quando o outro já propôs é aceitar
    assert.equal(g.result, '1/2-1/2');
    assert.equal(g.reason, 'agreement');
  });

  test('voltar lance: volta 1 se o adversário ainda não respondeu, 2 se já respondeu', () => {
    const g = game({ baseMs: 60_000, incMs: 0 });
    assert.equal(G.takeback(g, 'W', 'request', T0).error, 'not-allowed');
    playAll(g, ['e2e4', 'e7e5', 'g1f3']);
    G.takeback(g, 'W', 'request', T0 + 4000);
    assert.equal(G.takeback(g, 'W', 'accept', T0 + 4000).error, 'not-allowed', 'quem pede não aceita');
    G.takeback(g, 'B', 'accept', T0 + 4000);
    assert.deepEqual(g.moves, ['e2e4', 'e7e5']);
    assert.equal(g.chess.turn(), 'w');
    assert.equal(g.clock!.running, 'w');
    G.takeback(g, 'B', 'request', T0 + 5000);
    G.takeback(g, 'W', 'decline', T0 + 5000);
    assert.equal(g.takebackRequest, null);
    assert.equal(g.moves.length, 2);
    G.takeback(g, 'B', 'request', T0 + 5000);
    G.takeback(g, 'W', 'accept', T0 + 5000);
    assert.deepEqual(g.moves, ['e2e4']);
    assert.equal(g.clock!.running, null, 'antes do 2º lance, o relógio para');
    // Depois de voltar, o mesmo lance é aceito com o seq novo.
    assert.equal(G.applyMove(g, 'B', 1, 'c7c5', T0 + 6000).moved?.san, 'c5');
  });

  test('desconexão: vitória só depois da tolerância', () => {
    const g = game({ baseMs: 300_000, incMs: 0 });
    playAll(g, ['e2e4', 'e7e5']);
    assert.equal(G.claimVictory(g, 'W', T0 + 10_000, 60_000).error, 'not-allowed');
    G.setAway(g, 'B', T0 + 10_000);
    assert.equal(G.claimVictory(g, 'W', T0 + 69_000, 60_000).error, 'not-allowed');
    assert.equal(G.claimVictory(g, 'B', T0 + 80_000, 60_000).error, 'not-allowed');
    assert.equal(G.claimVictory(g, 'W', T0 + 71_000, 60_000).ended, true);
    assert.equal(g.result, '1-0');
    assert.equal(g.reason, 'abandon');
  });

  test('snapshot e restauração reconstroem a posição e o relógio', () => {
    const g = game({ baseMs: 60_000, incMs: 1_000 });
    playAll(g, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    G.draw(g, 'W', 'offer', T0 + 5000);
    const r = G.restore(JSON.parse(JSON.stringify(G.snapshot(g))));
    assert.equal(r.chess.fen(), g.chess.fen());
    assert.deepEqual(r.sans, g.sans);
    assert.deepEqual(r.clock, g.clock);
    assert.equal(r.drawOffer, 'w');
  });

  test('PGN com cabeçalhos e resultado', () => {
    const g = game({ baseMs: 300_000, incMs: 3_000 });
    playAll(g, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const pgn = G.toPgn(g, 'https://xadrez.test/p/jogo000001');
    assert.match(pgn, /\[White "Ana"\]/);
    assert.match(pgn, /\[Black "Bia"\]/);
    assert.match(pgn, /\[Result "0-1"\]/);
    assert.match(pgn, /\[TimeControl "300\+3"\]/);
    assert.match(pgn, /\[Termination "Xeque-mate"\]/);
    assert.match(pgn, /1\. f3 e5 2\. g4 Qh4# 0-1/);
    const back = new Chess();
    back.loadPgn(pgn);
    assert.equal(back.isCheckmate(), true);
  });
});

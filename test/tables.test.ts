// Mesas, partidas, relógio, ausência, restauração, chat e reações, no nível da sala (sem rede).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Room } from '../server/domain/room.ts';
import { errorCode, FakeClock, makeDeps, MemoryStore, msgs, play, roomWith } from './helpers.ts';

const firstTable = (room: Room) => [...room.tables.keys()][0]!;

describe('sala: mesas e partidas', () => {
  test('abrir mesa, sentar, cores pela escolha do dono; todos na sala recebem os lances (espectadores)', () => {
    const { room, ids } = roomWith(['Ana', 'Bia', 'Caio']);
    const [ana, bia, caio] = ids as [string, string, string];
    const opened = room.openTable(ana, { tc: { baseMs: 300_000, incMs: 0 }, color: 'black' });
    assert.equal(opened.at(-1)?.to, null);
    const tid = firstTable(room);
    assert.equal(errorCode(room.sit(ana, tid)), 'not-allowed', 'o dono não senta na própria mesa');
    room.sit(bia, tid);
    const g = room.tables.get(tid)!.game!;
    assert.equal(g.white, bia);
    assert.equal(g.black, ana);
    const outs = play(room, tid, bia, ana, ['e2e4']);
    const mv = msgs(outs, 'move')[0];
    assert.ok(mv && mv.t === 'move' && mv.seq === 1 && mv.san === 'e4');
    assert.ok(outs.every((o) => o.to === null), 'lances vão para a sala inteira');
    assert.equal(errorCode(room.move(caio, tid, 1, 'e7e5')), 'forbidden', 'espectador não joga');
  });

  test('cor sorteada usa o sorteio injetado', () => {
    const deps = makeDeps(new FakeClock(), new MemoryStore(), () => 0.9);
    const { room, ids } = roomWith(['Ana', 'Bia'], deps);
    room.openTable(ids[0]!, { tc: null, color: 'random' });
    const tid = firstTable(room);
    room.sit(ids[1]!, tid);
    assert.equal(room.tables.get(tid)!.game!.white, ids[1]);
  });

  test('desafio: só a pessoa desafiada senta, e ela pode recusar', () => {
    const { room, ids } = roomWith(['Ana', 'Bia', 'Caio']);
    const [ana, bia, caio] = ids as [string, string, string];
    room.openTable(ana, { tc: null, color: 'white', challenged: bia });
    const tid = firstTable(room);
    assert.equal(errorCode(room.sit(caio, tid)), 'forbidden');
    room.leave(bia, tid);
    assert.equal(room.tables.size, 0);
    assert.equal(errorCode(room.openTable(ana, { tc: null, color: 'white', challenged: ana })), 'not-allowed');
  });

  test('uma mesa aberta por pessoa, ninguém joga duas partidas ao mesmo tempo, e há limite de mesas', () => {
    const deps = makeDeps();
    deps.limits.maxPlayers = 6;
    const { room, ids } = roomWith(['Ana', 'Bia', 'Caio', 'Duda', 'Edu'], deps);
    const [ana, bia, caio, duda, edu] = ids as [string, string, string, string, string];
    room.openTable(ana, { tc: null, color: 'white' });
    room.openTable(ana, { tc: null, color: 'black' });
    assert.equal(room.tables.size, 1, 'a nova substitui a anterior');
    room.sit(bia, firstTable(room));
    assert.equal(errorCode(room.openTable(bia, { tc: null, color: 'white' })), 'busy');
    room.openTable(caio, { tc: null, color: 'white' });
    const ofCaio = [...room.tables.values()].find((t) => t.owner === caio)!.id;
    assert.equal(errorCode(room.sit(ana, ofCaio)), 'busy');
    room.openTable(duda, { tc: null, color: 'white' });
    room.openTable(edu, { tc: null, color: 'white' });
    assert.equal(room.tables.size, 4);
    const ofEdu = [...room.tables.values()].find((t) => t.owner === edu)!.id;
    room.leave(edu, ofEdu);
    assert.equal(room.tables.size, 3);
    room.openTable(edu, { tc: null, color: 'white' });
    assert.equal(room.tables.size, 4);
    // Limite de 4 mesas (makeDeps): uma quinta pessoa não consegue abrir.
    const extra = room.join({ nick: 'Fê' });
    assert.ok(!('error' in extra));
    room.connect(extra.player.id);
    assert.equal(errorCode(room.openTable(extra.player.id, { tc: null, color: 'white' })), 'table-limit');
  });

  test('abortar antes do 2º lance fecha a mesa sem registro; depois disso, não', () => {
    const store = new MemoryStore();
    const { room, ids } = roomWith(['Ana', 'Bia'], makeDeps(new FakeClock(), store));
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: null, color: 'white' });
    let tid = firstTable(room);
    room.sit(bia, tid);
    play(room, tid, ana, bia, ['e2e4']);
    assert.equal(msgs(room.abort(bia, tid), 'table.closed').length, 1);
    assert.equal(store.finished.length, 0);
    room.openTable(ana, { tc: null, color: 'white' });
    tid = firstTable(room);
    room.sit(bia, tid);
    play(room, tid, ana, bia, ['e2e4', 'e7e5']);
    assert.equal(errorCode(room.abort(ana, tid)), 'not-allowed');
  });

  test('fim de partida grava o PGN e entra na lista de terminadas; revanche troca as cores', () => {
    const store = new MemoryStore();
    const { room, ids } = roomWith(['Ana', 'Bia'], makeDeps(new FakeClock(), store));
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: { baseMs: 60_000, incMs: 0 }, color: 'white' });
    const tid = firstTable(room);
    room.sit(bia, tid);
    const outs = play(room, tid, ana, bia, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const fin = msgs(outs, 'finished')[0];
    assert.ok(fin && fin.t === 'finished' && fin.game.result === '0-1' && fin.game.reason === 'checkmate');
    assert.equal(store.finished.length, 1);
    assert.match(store.finished[0]!.pgn, /Qh4# 0-1/);
    assert.equal(room.view().finished.length, 1);
    const firstId = room.tables.get(tid)!.game!.id;
    assert.equal(errorCode(room.rematch(ana, 'naoexiste')), 'table-not-found');
    room.rematch(bia, tid);
    assert.equal(room.tables.get(tid)!.status, 'finished');
    assert.deepEqual(room.tables.get(tid)!.rematch, new Set([bia]));
    room.rematch(ana, tid);
    const g = room.tables.get(tid)!.game!;
    assert.notEqual(g.id, firstId);
    assert.equal(g.white, bia);
    assert.equal(g.black, ana);
    assert.equal(room.tables.get(tid)!.status, 'playing');
  });

  test('sair da mesa terminada fecha a mesa (e a revanche)', () => {
    const { room, ids } = roomWith(['Ana', 'Bia']);
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: null, color: 'white' });
    const tid = firstTable(room);
    room.sit(bia, tid);
    assert.equal(errorCode(room.leave(ana, tid)), 'not-allowed', 'durante a partida, não');
    room.resign(bia, tid);
    assert.equal(msgs(room.leave(bia, tid), 'table.closed').length, 1);
    assert.equal(errorCode(room.rematch(ana, tid)), 'table-not-found');
  });

  test('relógio: o próximo estouro é conhecido e tick encerra por tempo', () => {
    const clock = new FakeClock();
    const { room, ids } = roomWith(['Ana', 'Bia'], makeDeps(clock));
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: { baseMs: 60_000, incMs: 0 }, color: 'white' });
    const tid = firstTable(room);
    room.sit(bia, tid);
    assert.equal(room.nextFlagIn(), null);
    play(room, tid, ana, bia, ['e2e4', 'e7e5']);
    assert.equal(room.nextFlagIn(), 60_000);
    clock.advance(30_000);
    assert.equal(room.nextFlagIn(), 30_000);
    assert.deepEqual(room.tick(), []);
    clock.advance(30_001);
    assert.equal(msgs(room.tick(), 'finished').length, 1);
    assert.equal(room.tables.get(tid)!.game!.reason, 'timeout');
  });

  test('desconexão marca a ausência; a vitória só pode ser reivindicada depois da tolerância', () => {
    const clock = new FakeClock();
    const { room, ids } = roomWith(['Ana', 'Bia'], makeDeps(clock));
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: null, color: 'white' });
    const tid = firstTable(room);
    room.sit(bia, tid);
    play(room, tid, ana, bia, ['e2e4', 'e7e5']);
    const tv = msgs(room.disconnect(bia), 'table')[0];
    assert.ok(tv && tv.t === 'table' && tv.table.game!.awaySince.b === clock.t);
    clock.advance(30_000);
    assert.equal(errorCode(room.claim(ana, tid)), 'not-allowed');
    clock.advance(31_000);
    room.claim(ana, tid);
    assert.equal(room.tables.get(tid)!.game!.reason, 'abandon');
    assert.equal(room.tables.get(tid)!.game!.result, '1-0');
  });

  test('a volta do jogador limpa a ausência', () => {
    const { room, ids } = roomWith(['Ana', 'Bia']);
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: null, color: 'white' });
    const tid = firstTable(room);
    room.sit(bia, tid);
    room.disconnect(bia);
    room.connect(bia);
    assert.equal(room.tables.get(tid)!.game!.awaySince.b, null);
  });

  test('restauração: partida, relógio (sem contar o tempo fora do ar) e ausência voltam do snapshot', () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    const deps = makeDeps(clock, store);
    const { room, ids } = roomWith(['Ana', 'Bia'], deps);
    const [ana, bia] = ids as [string, string];
    room.openTable(ana, { tc: { baseMs: 60_000, incMs: 0 }, color: 'white' });
    const tid = firstTable(room);
    room.sit(bia, tid);
    play(room, tid, ana, bia, ['e2e4', 'e7e5', 'g1f3']);
    clock.advance(10_000);
    const c = room.tables.get(tid)!.game!.clock!;
    const blackLeft = c.remaining.b - (clock.t - c.since);
    clock.advance(3_600_000); // uma hora fora do ar
    const back = Room.restore(store.rooms.get(room.code)!, [...store.players.values()], [...store.tables.values()], [], deps);
    const g = back.tables.get(tid)!.game!;
    assert.deepEqual(g.moves, ['e2e4', 'e7e5', 'g1f3']);
    // O snapshot é do último lance: os 10 s depois dele (antes de cair) também não contam.
    assert.equal(g.clock!.remaining.b - (clock.t - g.clock!.since), blackLeft + 10_000);
    assert.deepEqual(g.awaySince, { w: clock.t, b: clock.t });
    assert.equal(back.creator, ana);
  });
});

describe('sala: chat e reações', () => {
  test('chat limpa o texto, limita tamanho e taxa, e guarda as últimas mensagens por canal', () => {
    const clock = new FakeClock();
    const { room, ids } = roomWith(['Ana', 'Bia'], makeDeps(clock));
    const [ana] = ids as [string];
    const out = msgs(room.say(ana, 'room', '  oi\u0000 <b>todos</b>  '), 'chat')[0];
    assert.ok(out && out.t === 'chat');
    assert.equal(out.msg.text, 'oi <b>todos</b>', 'o servidor só limpa; quem escapa é o front (textContent)');
    assert.equal(errorCode(room.say(ana, 'room', 'x'.repeat(301))), 'bad-message');
    assert.equal(errorCode(room.say(ana, 'room', '   ')), 'bad-message');
    assert.equal(errorCode(room.say(ana, 'naoexiste', 'oi')), 'not-allowed');
    room.say(ana, 'room', 'dois');
    room.say(ana, 'room', 'três');
    assert.equal(errorCode(room.say(ana, 'room', 'quatro')), 'rate-limited');
    clock.advance(2_000);
    assert.equal(errorCode(room.say(ana, 'room', 'quatro')), undefined);
    for (let i = 0; i < 5; i++) {
      clock.advance(2_000);
      room.say(ana, 'room', `m${i}`);
    }
    assert.equal(room.view().chat.length, 5, 'guarda as últimas 5 (keepChat)');
  });

  test('reações: só as da lista, com limite de taxa silencioso', () => {
    const { room, ids } = roomWith(['Ana']);
    const [ana] = ids as [string];
    assert.equal(msgs(room.react(ana, 'room', '🔥'), 'react').length, 1);
    assert.equal(errorCode(room.react(ana, 'room', '💩')), 'bad-message');
    room.react(ana, 'room', '👍');
    assert.deepEqual(room.react(ana, 'room', '👍'), []);
  });

  test('o chat de uma mesa some quando a mesa fecha', () => {
    const { room, ids } = roomWith(['Ana', 'Bia']);
    room.openTable(ids[0]!, { tc: null, color: 'white' });
    const tid = firstTable(room);
    room.say(ids[1]!, tid, 'vamos?');
    assert.equal(room.view().chat.length, 1);
    room.leave(ids[0]!, tid);
    assert.equal(room.view().chat.length, 0);
  });
});

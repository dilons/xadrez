// Integração: HTTP, WebSocket e SQLite de verdade, numa porta livre.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { Client, createRoom, joinAs, startServer, type Running } from './server-helpers.ts';

const running: Running[] = [];
after(async () => {
  for (const s of running) await s.stop().catch(() => {});
});
async function server(over = {}) {
  const s = await startServer(over);
  running.push(s);
  return s;
}

describe('HTTP', () => {
  test('cria sala, responde /healthz e limita salas por IP', async () => {
    const s = await server({ roomsPerIpPerHour: 2 });
    const h = (await (await fetch(`${s.url}/healthz`)).json()) as { ok: boolean };
    assert.equal(h.ok, true);
    const r = await createRoom(s);
    assert.match(r.code, /^[a-z2-9]{10}$/);
    assert.ok(r.creatorKey.length >= 20);
    await createRoom(s);
    const third = await fetch(`${s.url}/api/rooms`, { method: 'POST', headers: { origin: s.origin } });
    assert.equal(third.status, 429);
    const noOrigin = await fetch(`${s.url}/api/rooms`, { method: 'POST', headers: { origin: 'https://outro.site' } });
    assert.equal(noOrigin.status, 403);
  });

  test('cabeçalhos de segurança e 404 para partida que não existe', async () => {
    const s = await server();
    const r = await fetch(`${s.url}/api/games/naoexiste1`);
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
});

describe('WebSocket: proteções', () => {
  test('recusa Origin de outro site e conexão sem Origin', async () => {
    const s = await server();
    await assert.rejects(new Client(s, { origin: 'https://malicioso.example' }).opened, /403/);
    await assert.rejects(new Client(s, {}).opened, /403/);
  });

  test('limita conexões por IP', async () => {
    const s = await server({ connectionsPerIp: 2 });
    const a = new Client(s);
    const b = new Client(s);
    await Promise.all([a.opened, b.opened]);
    await assert.rejects(new Client(s).opened, /429/);
    await a.close();
    await new Promise((r) => setTimeout(r, 50));
    const c = new Client(s);
    await c.opened;
    b.close();
    c.close();
  });

  test('mensagem grande demais derruba a conexão; mensagem inválida recebe erro', async () => {
    const s = await server({ maxMessageBytes: 512 });
    const c = new Client(s);
    await c.opened;
    c.send({ t: 'nao-existe' });
    assert.equal((await c.next('error')).code, 'bad-message');
    c.send({ t: 'table.sit', table: 'abcd' });
    assert.equal((await c.next('error')).code, 'not-joined');
    c.ws.send('x'.repeat(2000));
    const closed = await c.closed;
    assert.equal(closed.code, 1009);
  });

  test('limite de taxa por conexão', async () => {
    const s = await server({ messageBurst: 5, messagesPerSecond: 1 });
    const c = new Client(s);
    await c.opened;
    for (let i = 0; i < 8; i++) c.send({ t: 'ping' });
    assert.equal((await c.next('error')).code, 'rate-limited');
    c.close();
  });
});

describe('WebSocket: sala, presença e reconexão', () => {
  test('entra com apelido, vê os outros chegarem e saírem, e volta com id e segredo', async () => {
    const s = await server();
    const { code, creatorKey } = await createRoom(s);
    const ana = await joinAs(s, code, 'Ana', creatorKey);
    assert.ok(ana.secret);
    assert.equal(ana.w.room.creator, ana.id);
    assert.equal(ana.w.room.players.find((p) => p.id === ana.id)?.online, true);

    const bia = await joinAs(s, code, 'Bia');
    const seen = await ana.c.next('player');
    assert.equal(seen.player.nick, 'Bia');
    assert.equal(seen.player.online, true);
    assert.ok(!JSON.stringify(seen).includes(bia.secret), 'o segredo da Bia não vai para a Ana');

    await bia.c.close();
    const left = await ana.c.next('player');
    assert.equal(left.player.online, false);

    const again = new Client(s);
    await again.opened;
    again.send({ t: 'join', room: code, id: bia.id, secret: bia.secret });
    const w = await again.next('welcome');
    assert.equal(w.me.id, bia.id);
    assert.equal(w.me.secret, undefined);
    assert.equal((await ana.c.next('player')).player.online, true);

    const dup = new Client(s);
    await dup.opened;
    dup.send({ t: 'join', room: code, nick: 'bia' });
    assert.equal((await dup.next('error')).code, 'nick-taken');
    const wrong = new Client(s);
    await wrong.opened;
    wrong.send({ t: 'join', room: code, id: bia.id, secret: 'chute-errado' });
    assert.equal((await wrong.next('error')).code, 'bad-identity');
    const lost = new Client(s);
    await lost.opened;
    lost.send({ t: 'join', room: 'naoexiste99', nick: 'X' });
    assert.equal((await lost.next('error')).code, 'room-not-found');
    for (const c of [ana.c, again, dup, wrong, lost]) c.close();
  });

  test('o criador remove alguém: a conexão dele cai e o segredo deixa de valer', async () => {
    const s = await server();
    const { code, creatorKey } = await createRoom(s);
    const ana = await joinAs(s, code, 'Ana', creatorKey);
    const caio = await joinAs(s, code, 'Caio');
    caio.c.send({ t: 'kick', player: ana.id });
    assert.equal((await caio.c.next('error')).code, 'forbidden');
    ana.c.send({ t: 'kick', player: caio.id });
    await caio.c.next('kicked');
    assert.equal((await caio.c.closed).code, 4001);
    const back = new Client(s);
    await back.opened;
    back.send({ t: 'join', room: code, id: caio.id, secret: caio.secret });
    assert.equal((await back.next('error')).code, 'removed');
    ana.c.close();
    back.close();
  });

  test('depois de um restart, a sala, as pessoas e a partida em andamento voltam do SQLite', async () => {
    const s1 = await startServer();
    const { code, creatorKey } = await createRoom(s1);
    const ana = await joinAs(s1, code, 'Ana', creatorKey);
    const bia = await joinAs(s1, code, 'Bia');
    ana.c.send({ t: 'table.open', tc: { baseMs: 300_000, incMs: 0 }, color: 'white' });
    const open = await ana.c.next('table');
    bia.c.send({ t: 'table.sit', table: open.table.id });
    await bia.c.next('table');
    await bia.c.next('table');
    ana.c.send({ t: 'move', table: open.table.id, seq: 0, uci: 'e2e4' });
    await bia.c.next('move');
    bia.c.send({ t: 'move', table: open.table.id, seq: 1, uci: 'e7e5' });
    await ana.c.next('move');
    await s1.stop(true);

    const s2 = await startServer({}, s1.dir);
    running.push(s2);
    assert.equal(s2.app.restored, 1);
    const c = new Client(s2);
    await c.opened;
    c.send({ t: 'join', room: code, id: ana.id, secret: ana.secret });
    const w = await c.next('welcome');
    const t = w.room.tables.find((x) => x.id === open.table.id);
    assert.ok(t?.game);
    assert.deepEqual(t.game.moves, ['e2e4', 'e7e5']);
    assert.equal(t.game.clock?.running, 'w');
    assert.equal(w.room.creator, ana.id);
    // E dá para continuar jogando de onde parou.
    c.send({ t: 'move', table: t.id, seq: 2, uci: 'g1f3' });
    const m = await c.next('move');
    assert.equal(m.san, 'Nf3');
    c.close();
  });
});

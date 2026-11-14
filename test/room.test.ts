import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Room } from '../server/domain/room.ts';
import { errorCode, FakeClock, makeDeps, MemoryStore, msgs, roomWith } from './helpers.ts';

describe('sala: entrada e apelidos', () => {
  test('quem entra com a chave de criador vira o criador; a chave só vale uma vez', () => {
    const deps = makeDeps();
    const { room, creatorKey } = Room.create('abcdefghjk', deps);
    const a = room.join({ nick: 'Ana', creatorKey });
    assert.ok(!('error' in a));
    assert.equal(room.creator, a.player.id);
    const b = room.join({ nick: 'Bia', creatorKey });
    assert.ok(!('error' in b));
    assert.equal(room.creator, a.player.id);
  });

  test('sem a chave, ninguém vira criador', () => {
    const { room } = Room.create('abcdefghjk', makeDeps());
    const a = room.join({ nick: 'Ana', creatorKey: 'chute' });
    assert.ok(!('error' in a));
    assert.equal(room.creator, null);
  });

  test('apelido é limpo, tem tamanho limitado e não se repete (nem com acento, caixa ou espaço)', () => {
    const { room } = roomWith(['José Maria']);
    for (const nick of ['jose maria', 'JOSÉ MARIA', 'Jose​Maria', 'josé  maria']) {
      const r = room.join({ nick });
      assert.ok('error' in r && r.error === 'nick-taken', nick);
    }
    for (const nick of ['', '   ', 'x'.repeat(21), 42, '\u0000\u0001']) {
      const r = room.join({ nick });
      assert.ok('error' in r && r.error === 'bad-nick', String(nick));
    }
    const ok = room.join({ nick: '  Zé\n\tda   Silva  ' });
    assert.ok(!('error' in ok));
    assert.equal(ok.player.nick, 'Zé da Silva');
  });

  test('a sala tem lotação máxima', () => {
    const { room } = roomWith(['a1', 'a2', 'a3', 'a4', 'a5']);
    const r = room.join({ nick: 'a6' });
    assert.ok('error' in r && r.error === 'room-full');
  });

  test('o segredo só volta para a própria pessoa e não aparece na vista da sala', () => {
    const { room, secrets } = roomWith(['Ana', 'Bia']);
    const v = JSON.stringify(room.view());
    for (const s of secrets) assert.ok(!v.includes(s));
    assert.ok(!v.includes('secret'));
  });
});

describe('sala: reconexão e presença', () => {
  test('volta para o mesmo lugar com id e segredo; segredo errado é recusado', () => {
    const { room, ids, secrets } = roomWith(['Ana']);
    const r = room.join({ id: ids[0], secret: secrets[0] });
    assert.ok(!('error' in r));
    assert.equal(r.player.id, ids[0]);
    assert.equal(r.secret, undefined);
    const bad = room.join({ id: ids[0], secret: 'outro' });
    assert.ok('error' in bad && bad.error === 'bad-identity');
    const ghost = room.join({ id: 'naoexiste', secret: secrets[0] });
    assert.ok('error' in ghost && ghost.error === 'bad-identity');
  });

  test('presença conta várias abas: só fica offline quando a última fecha', () => {
    const { room, ids } = roomWith(['Ana', 'Bia']);
    const [ana] = ids as [string];
    assert.deepEqual(room.connect(ana), []); // segunda aba: ninguém precisa saber
    assert.deepEqual(room.disconnect(ana), []);
    assert.equal(room.isOnline(ana), true);
    const outs = room.disconnect(ana);
    const p = msgs(outs, 'player')[0];
    assert.ok(p && p.t === 'player' && p.player.online === false);
    assert.equal(room.view().players.find((x) => x.id === ana)?.online, false);
    const back = msgs(room.connect(ana), 'player')[0];
    assert.ok(back && back.t === 'player' && back.player.online === true);
  });

  test('sala sem ninguém conectado expira depois do prazo', () => {
    const clock = new FakeClock();
    const { room, ids } = roomWith(['Ana'], makeDeps(clock));
    const ttl = 7 * 86_400_000;
    assert.equal(room.expired(ttl), false);
    room.disconnect(ids[0]!);
    clock.advance(ttl - 1000);
    assert.equal(room.expired(ttl), false);
    clock.advance(2000);
    assert.equal(room.expired(ttl), true);
    room.connect(ids[0]!);
    assert.equal(room.expired(ttl), false);
  });
});

describe('sala: remoção', () => {
  test('só o criador remove; o removido recebe aviso e não volta com o mesmo segredo', () => {
    const { room, ids, secrets } = roomWith(['Ana', 'Bia', 'Caio']);
    const [ana, bia, caio] = ids as [string, string, string];
    assert.equal(errorCode(room.kick(bia, caio)), 'forbidden');
    assert.equal(errorCode(room.kick(ana, ana)), 'forbidden');
    const outs = room.kick(ana, caio);
    assert.ok(outs.some((o) => o.to === caio && o.msg.t === 'kicked'));
    assert.ok(outs.some((o) => o.to === null && o.msg.t === 'player.removed'));
    const again = room.join({ id: caio, secret: secrets[2] });
    assert.ok('error' in again && again.error === 'removed');
    assert.ok(!room.view().players.some((p) => p.id === caio));
    // O apelido continua reservado: ninguém entra como "Caio" para se passar por ele.
    const imp = room.join({ nick: 'caio' });
    assert.ok('error' in imp && imp.error === 'nick-taken');
  });

  test('remover quem está jogando dá a vitória ao adversário e fecha as mesas abertas dele', () => {
    const store = new MemoryStore();
    const { room, ids } = roomWith(['Ana', 'Bia', 'Caio'], makeDeps(new FakeClock(), store));
    const [ana, bia, caio] = ids as [string, string, string];
    room.openTable(bia, { tc: null, color: 'white' });
    const tid = [...room.tables.keys()][0]!;
    room.sit(caio, tid);
    room.kick(ana, bia);
    const t = room.tables.get(tid)!;
    assert.equal(t.status, 'finished');
    assert.equal(t.game?.result, '0-1');
    assert.equal(t.game?.reason, 'removed');
    assert.equal(store.finished.length, 1);
  });
});

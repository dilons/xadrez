// IP do visitante atrás do traefik e da Cloudflare: CF-Connecting-IP só vale vindo de CF_TRUSTED_PEERS; IPv6 por /64.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { after, describe, test } from 'node:test';
import { clientIp, inRanges, ipKey, parseRanges } from '../server/ip.ts';
import { Client, startServer, type Running } from './server-helpers.ts';

function req(headers: Record<string, string>, remoteAddress = '10.42.3.7'): IncomingMessage {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('faixas e chave do IP', () => {
  test('parseRanges e inRanges, com IPv4, IPv6 e IPv4 mapeado', () => {
    const r = parseRanges(' 10.42.0.0/16, 192.168.1.0/24 ,2001:db8::/32,203.0.113.9');
    assert.ok(inRanges('10.42.200.1', r));
    assert.ok(inRanges('::ffff:192.168.1.40', r));
    assert.ok(inRanges('2001:db8:abcd::1', r));
    assert.ok(inRanges('203.0.113.9', r));
    assert.ok(!inRanges('203.0.113.10', r));
    assert.ok(!inRanges('10.43.0.1', r));
    assert.ok(!inRanges('2001:db9::1', r));
    assert.ok(!inRanges('lixo', r));
    assert.ok(!inRanges(undefined, r));
    assert.deepEqual(parseRanges(''), []);
    assert.ok(inRanges('104.16.1.1', parseRanges('cloudflare')));
  });

  test('parseRanges recusa faixa inválida (o servidor não sobe com a configuração errada)', () => {
    for (const bad of ['10.0.0.0/33', '10.0.0.0/x', 'nao-e-ip', '10.0.0.0/8/1', '2001:db8::/129', '10.0.0.0/']) {
      assert.throws(() => parseRanges(bad), /CF_TRUSTED_PEERS: faixa inválida/, bad);
    }
  });

  test('ipKey: IPv4 inteiro (sem o ::ffff:), IPv6 pelo /64', () => {
    assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
    assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(ipKey('[2001:DB8:1:2::9]'), '2001:db8:1:2::/64');
    assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
    assert.equal(ipKey('::1'), '0:0:0:0::/64');
    assert.equal(ipKey(undefined), '?');
  });
});

describe('clientIp', () => {
  const peers = parseRanges('10.42.0.0/16');

  test('sem TRUST_PROXY, só o endereço da conexão vale', () => {
    const cfg = { trustProxy: false, cfTrustedPeers: peers };
    assert.equal(clientIp(req({ 'X-Forwarded-For': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' }, '10.42.0.9'), cfg), '10.42.0.9');
  });

  test('com TRUST_PROXY, vale o último salto do X-Forwarded-For (o primeiro é do cliente)', () => {
    const cfg = { trustProxy: true, cfTrustedPeers: [] };
    assert.equal(clientIp(req({ 'X-Forwarded-For': '6.6.6.6, 198.51.100.4' }), cfg), '198.51.100.4');
    assert.equal(clientIp(req({}, '198.51.100.8'), cfg), '198.51.100.8');
  });

  test('sem CF_TRUSTED_PEERS, o CF-Connecting-IP é ignorado', () => {
    const cfg = { trustProxy: true, cfTrustedPeers: [] };
    assert.equal(clientIp(req({ 'X-Forwarded-For': '10.42.1.1', 'CF-Connecting-IP': '203.0.113.7' }), cfg), '10.42.1.1');
  });

  test('pelo conector confiável, vale o CF-Connecting-IP; de fora da lista, não', () => {
    const cfg = { trustProxy: true, cfTrustedPeers: peers };
    // O traefik troca o X-Forwarded-For pelo IP de quem conectou (o cloudflared).
    assert.equal(clientIp(req({ 'X-Forwarded-For': '10.42.1.1', 'CF-Connecting-IP': '203.0.113.7' }), cfg), '203.0.113.7');
    assert.equal(clientIp(req({ 'X-Forwarded-For': '6.6.6.6, 10.42.1.1', 'CF-Connecting-IP': '203.0.113.7' }), cfg), '203.0.113.7');
    assert.equal(
      clientIp(req({ 'X-Forwarded-For': '10.42.1.1', 'CF-Connecting-IP': '2001:db8:1:2:3:4:5:6' }), cfg),
      '2001:db8:1:2::/64',
    );
    // Direto na origem (salto fora da lista): o cabeçalho não muda a identidade.
    assert.equal(clientIp(req({ 'X-Forwarded-For': '198.51.100.4', 'CF-Connecting-IP': '203.0.113.7' }), cfg), '198.51.100.4');
    // Cabeçalho que não é um IP: fica o salto.
    assert.equal(clientIp(req({ 'X-Forwarded-For': '10.42.1.1', 'CF-Connecting-IP': '1.2.3.4, 5.6.7.8' }), cfg), '10.42.1.1');
  });
});

describe('limites por IP atrás da Cloudflare (servidor de verdade)', () => {
  const running: Running[] = [];
  after(async () => {
    for (const s of running) await s.stop().catch(() => {});
  });
  // Nos testes a conexão vem de 127.0.0.1; o "traefik" é simulado pelo X-Forwarded-For.
  const server = async () => {
    const s = await startServer({
      trustProxy: true,
      cfTrustedPeers: parseRanges('10.42.0.0/16'),
      roomsPerIpPerHour: 1,
      connectionsPerIp: 1,
    });
    running.push(s);
    return s;
  };

  test('salas por hora contam por visitante, não pelo conector', async () => {
    const s = await server();
    const post = (h: Record<string, string>) =>
      fetch(`${s.url}/api/rooms`, { method: 'POST', headers: { origin: s.origin, ...h } }).then((r) => r.status);
    const viaTunnel = (ip: string) => ({ 'X-Forwarded-For': '10.42.0.5', 'CF-Connecting-IP': ip });
    assert.equal(await post(viaTunnel('203.0.113.1')), 201);
    assert.equal(await post(viaTunnel('203.0.113.2')), 201);
    assert.equal(await post(viaTunnel('203.0.113.1')), 429);
    // Mesmo /64 de IPv6: mesma pessoa.
    assert.equal(await post(viaTunnel('2001:db8:0:1::1')), 201);
    assert.equal(await post(viaTunnel('2001:db8:0:1::2')), 429);
    // Direto na origem, trocar o CF-Connecting-IP não cria identidade nova.
    assert.equal(await post({ 'X-Forwarded-For': '198.51.100.9', 'CF-Connecting-IP': '203.0.113.50' }), 201);
    assert.equal(await post({ 'X-Forwarded-For': '198.51.100.9', 'CF-Connecting-IP': '203.0.113.51' }), 429);
  });

  test('conexões simultâneas contam por visitante', async () => {
    const s = await server();
    const ws = (ip: string) => new Client(s, { origin: s.origin, 'X-Forwarded-For': '10.42.0.5', 'CF-Connecting-IP': ip });
    const a = ws('203.0.113.1');
    const b = ws('203.0.113.2');
    await Promise.all([a.opened, b.opened]);
    await assert.rejects(ws('203.0.113.1').opened, /429/);
    a.close();
    b.close();
  });
});

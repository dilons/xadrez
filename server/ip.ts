// IP do visitante, para os limites por IP (conexões simultâneas e salas criadas por hora).
//
// Sem TRUST_PROXY, vale o endereço de quem abriu a conexão. Com TRUST_PROXY=1, vale o ÚLTIMO item de X-Forwarded-For,
// o que o proxy mais próximo acrescentou (os anteriores são escolha do cliente). Atrás da Cloudflare isso não basta:
// pelo túnel, o último salto é sempre o conector (cloudflared), e todo mundo pareceria o mesmo IP. Por isso, quando
// esse salto está em CF_TRUSTED_PEERS, vale o CF-Connecting-IP, que a Cloudflare reescreve (o cliente não o forja).
// Sem CF_TRUSTED_PEERS o cabeçalho é ignorado: quem alcançasse a origem direto trocaria de IP a cada pedido.
//
// IPv6 conta por /64: uma única casa costuma ter o bloco inteiro e trocaria de endereço à vontade.
import { isIPv4, isIPv6 } from 'node:net';
import type { IncomingMessage } from 'node:http';

/** Faixa CIDR já convertida: versão, bits descartados e o prefixo. */
export interface CidrRange {
  v: 4 | 6;
  shift: bigint;
  base: bigint;
}

// Faixas públicas da Cloudflare (https://www.cloudflare.com/ips/), para CF_TRUSTED_PEERS=cloudflare.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

/** Endereço como número (BigInt) e versão; null se não for um IP. `::ffff:1.2.3.4` vira IPv4. */
export function ipBits(ip: string | undefined): { v: 4 | 6; n: bigint } | null {
  let s = (ip ?? '').trim().replace(/^\[|\]$/g, '');
  if (s.toLowerCase().startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (isIPv4(s)) return { v: 4, n: s.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n) };
  if (!isIPv6(s)) return null;
  s = s.replace(/%.*$/, ''); // zona (fe80::1%eth0)
  const [head = '', tail = ''] = s.split('::');
  const part = (x: string) => (x ? x.split(':') : []);
  const h = part(head);
  const t = s.includes('::') ? part(tail) : [];
  const groups = [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16) || 0), 0n) };
}

/** "10.42.0.0/16,192.168.1.0/24" (ou "cloudflare") → faixas. Lança com a faixa inválida na mensagem. */
export function parseRanges(spec: string): CidrRange[] {
  const items = spec
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((x) => (x.toLowerCase() === 'cloudflare' ? CLOUDFLARE_RANGES : [x]));
  return items.map((cidr) => {
    const [addr, len, extra] = cidr.split('/');
    const b = ipBits(addr);
    const total = b?.v === 4 ? 32 : 128;
    const bits = len === undefined ? total : Number(len);
    if (!b || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > total || (len !== undefined && !/^\d+$/.test(len))) {
      throw new Error(`CF_TRUSTED_PEERS: faixa inválida "${cidr}"`);
    }
    const shift = BigInt(total - bits);
    return { v: b.v, shift, base: b.n >> shift };
  });
}

export function inRanges(ip: string | undefined, ranges: readonly CidrRange[]): boolean {
  const b = ipBits(ip);
  return Boolean(b && ranges.some((r) => r.v === b.v && b.n >> r.shift === r.base));
}

/** Chave para os limites: IPv4 inteiro; IPv6 pelo /64 (`2001:db8:1:2::/64`). */
export function ipKey(ip: string | undefined): string {
  const b = ipBits(ip);
  if (!b) return ip?.trim() || '?';
  if (b.v === 4) return [24n, 16n, 8n, 0n].map((s) => ((b.n >> s) & 255n).toString()).join('.');
  const prefix = b.n >> 64n;
  const groups = [48n, 32n, 16n, 0n].map((s) => ((prefix >> s) & 0xffffn).toString(16));
  return `${groups.join(':')}::/64`;
}

export interface ProxyTrust {
  trustProxy: boolean;
  cfTrustedPeers: readonly CidrRange[];
}

export function clientIp(req: IncomingMessage, cfg: ProxyTrust): string {
  const socketIp = req.socket.remoteAddress;
  if (!cfg.trustProxy) return ipKey(socketIp);
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v.join(',') : (v ?? '')).trim();
  };
  const hops = header('x-forwarded-for')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const peer = hops.at(-1) ?? socketIp;
  const cf = header('cf-connecting-ip');
  if (cf && cfg.cfTrustedPeers.length > 0 && inRanges(peer, cfg.cfTrustedPeers) && ipBits(cf)) return ipKey(cf);
  return ipKey(peer);
}

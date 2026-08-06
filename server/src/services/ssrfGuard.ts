import dns from 'dns/promises';
import net from 'net';
import https from 'https';
import { env } from '../env';

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function ipv4Number(ip: string) {
  return ip.split('.').reduce((result, octet) => (result << 8) + Number(octet), 0) >>> 0;
}

function ipv4Range(ip: string, base: string, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask);
}

function mappedIpv4(ip: string): string | undefined {
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':'); const dotted = value.slice(lastColon + 1);
    if (net.isIP(dotted) !== 4) return undefined;
    const octets = dotted.split('.').map(Number);
    value = `${value.slice(0, lastColon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const split = value.split('::');
  if (split.length > 2) return undefined;
  const left = split[0] ? split[0].split(':') : [];
  const right = split.length === 2 && split[1] ? split[1].split(':') : [];
  const missing = split.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  const numbers = words.map(word => Number.parseInt(word, 16));
  if (numbers.slice(0, 5).some(Boolean) || numbers[5] !== 0xffff) return undefined;
  return `${numbers[6]! >> 8}.${numbers[6]! & 0xff}.${numbers[7]! >> 8}.${numbers[7]! & 0xff}`;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0] || '';
  const version = net.isIP(normalized);
  if (version === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, prefix]) => ipv4Range(normalized, String(base), Number(prefix)));
  }
  if (version === 6) {
    const mapped = mappedIpv4(normalized);
    if (mapped) return isPrivateOrReservedIp(mapped);
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      return isPrivateOrReservedIp(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
    }
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('ff') || normalized.startsWith('2001:db8:') || normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

function hostnameAllowed(hostname: string, allowlist: string[]) {
  if (!allowlist.length) return true;
  return allowlist.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

export interface ValidatedOutboundUrl { url: URL; addresses: string[]; }

export function pinnedHttpsAgent(validated: ValidatedOutboundUrl) {
  const address = validated.addresses[0];
  if (!address) throw new Error('No validated outbound address is available');
  const family = net.isIP(address);
  if (!family) throw new Error('No validated outbound address is available');
  return new https.Agent({
    keepAlive: false,
    lookup: ((_hostname: string, _options: any, callback: any) => callback(null, address, family)) as any,
  });
}

export async function validateOutboundUrl(input: string, options: { allowHttp?: boolean; allowedHosts?: string[] } = {}): Promise<ValidatedOutboundUrl> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Outbound URL is invalid'); }
  if (url.username || url.password) throw new Error('Credentials in outbound URLs are not allowed');
  const allowHttp = options.allowHttp === true;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new Error('Only HTTPS outbound URLs are allowed');
  if ((url.protocol === 'https:' && url.port && url.port !== '443') || (url.protocol === 'http:' && url.port && !['80', '8080'].includes(url.port))) {
    throw new Error('Outbound URL port is not allowed');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new Error('Outbound URL targets a blocked host');
  }
  const envAllowlist = env.OUTBOUND_HTTP_ALLOWLIST.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const allowlist = options.allowedHosts || envAllowlist;
  if (!hostnameAllowed(hostname, allowlist)) throw new Error('Outbound URL host is not allowlisted');

  let addresses: string[];
  if (net.isIP(hostname)) addresses = [hostname];
  else {
    const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = Array.from(new Set(resolved.map(item => item.address)));
  }
  if (!addresses.length || addresses.some(isPrivateOrReservedIp)) throw new Error('Outbound URL resolves to a private or reserved address');
  return { url, addresses };
}

export function safeRequestHeaders(headers: Record<string, string>) {
  const denied = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization', 'x-forwarded-for', 'forwarded']);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !denied.has(key.toLowerCase())));
}

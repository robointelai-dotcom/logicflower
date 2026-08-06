import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedIp, validateOutboundUrl } from '../src/services/ssrfGuard';

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.0.0.4', '100.64.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:6440:1', '0:0:0:0:0:ffff:a9fe:a9fe', '2001:db8::1'])('blocks %s', value => expect(isPrivateOrReservedIp(value)).toBe(true));
  it('allows a public address', () => expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false));
  it('allows a public IPv4-mapped address', () => expect(isPrivateOrReservedIp('::ffff:0808:0808')).toBe(false));
  it('rejects credentials and local hosts', async () => {
    await expect(validateOutboundUrl('https://user:pass@example.com')).rejects.toThrow(/Credentials/);
    await expect(validateOutboundUrl('https://127.0.0.1/')).rejects.toThrow(/private|reserved/);
  });
});

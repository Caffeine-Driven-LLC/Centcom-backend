/**
 * Client addresses (B023, card test client-ip.test.ts): proxy chains, spoofed X-Forwarded-For
 * (acceptance 6), Fly-Client-IP, IPv6 /64 buckets, malformed headers and missing addresses.
 */
import { isIP } from 'node:net';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ipBucket,
  MAX_TRUSTED_HOPS,
  normalizeIp,
  resolveClientIp,
  UNKNOWN_IP,
  type ClientIpSource,
} from '../../src/index.js';

/** A request from `peer` with `headers`. */
const req = (
  peer: string | undefined,
  headers: Record<string, string | string[]> = {},
): ClientIpSource => ({ headers, socket: { remoteAddress: peer } });

const PROXY = '10.0.0.2';

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['203.0.113.7:51234', '203.0.113.7'],
    ['2001:DB8::1', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['::1', '::1'],
  ])('reads %j as %j', (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '   ',
    'unknown',
    'example.com',
    '203.0.113',
    '256.0.0.1',
    '203.0.113.7:99999999',
    '2001:db8::1::2',
    '[203.0.113.7',
    '1'.repeat(101),
  ])('refuses %j', (raw) => {
    expect(normalizeIp(raw)).toBeUndefined();
  });

  it('never throws, and returns only lower-case addresses Node accepts (property)', () => {
    const text = fc.oneof(fc.string({ maxLength: 120 }), fc.ipV4(), fc.ipV6(), fc.ipV4Extended());
    fc.assert(
      fc.property(text, (raw) => {
        const ip = normalizeIp(raw);
        if (ip !== undefined) {
          expect(isIP(ip)).not.toBe(0);
          expect(ip).toBe(ip.toLowerCase());
          expect(normalizeIp(ip)).toBe(ip);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('ipBucket', () => {
  it('keeps IPv4 addresses and the unknown address as they are', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket(UNKNOWN_IP)).toBe(UNKNOWN_IP);
  });

  it.each([
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['::', '0:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['64:ff9b::203.0.113.7', '64:ff9b:0:0::/64'],
    ['1:2:3:4:5:6:203.0.113.7', '1:2:3:4::/64'],
    ['fe80::', 'fe80:0:0:0::/64'],
  ])('puts %j in %j', (ip, bucket) => {
    expect(ipBucket(ip)).toBe(bucket);
  });

  it('puts every address of a /64 in one bucket, and other /64s in others', () => {
    const one = ['2001:db8:a:b::1', '2001:db8:a:b:ffff::2', '2001:db8:a:b:1:2:3:4'].map(ipBucket);
    expect(new Set(one).size).toBe(1);
    expect(ipBucket('2001:db8:a:c::1')).not.toBe(one[0]);
  });
});

describe('resolveClientIp', () => {
  it('uses the socket address with no trusted proxies, whatever the headers say', () => {
    const headers = { 'x-forwarded-for': '198.51.100.1', 'fly-client-ip': '198.51.100.2' };
    expect(resolveClientIp(req('203.0.113.7', headers), 0)).toBe('203.0.113.7');
    expect(resolveClientIp(req('::ffff:203.0.113.7'), 0)).toBe('203.0.113.7');
  });

  it('takes the address the trusted proxy appended, never one the client wrote (acceptance 6)', () => {
    const appended = '203.0.113.7';
    for (const spoofed of ['', '1.1.1.1, ', '1.1.1.1, 2.2.2.2, ', 'nonsense, ', '::1, ']) {
      const ip = resolveClientIp(req(PROXY, { 'x-forwarded-for': `${spoofed}${appended}` }), 1);
      expect(ip).toBe(appended);
    }
  });

  it('walks one entry per trusted proxy from the right, and stops at the leftmost', () => {
    const chain = { 'x-forwarded-for': '198.51.100.9, 203.0.113.7, 10.0.0.1' };
    expect(resolveClientIp(req(PROXY, chain), 1)).toBe('10.0.0.1');
    expect(resolveClientIp(req(PROXY, chain), 2)).toBe('203.0.113.7');
    expect(resolveClientIp(req(PROXY, chain), 3)).toBe('198.51.100.9');
    // Fewer entries than proxies configured: the farthest any trusted proxy reported.
    expect(resolveClientIp(req(PROXY, chain), MAX_TRUSTED_HOPS)).toBe('198.51.100.9');
  });

  it('reads repeated X-Forwarded-For headers as one chain', () => {
    const headers = { 'x-forwarded-for': ['198.51.100.9', '203.0.113.7'] };
    expect(resolveClientIp(req(PROXY, headers), 1)).toBe('203.0.113.7');
    expect(resolveClientIp(req(PROXY, headers), 2)).toBe('198.51.100.9');
  });

  it('ends the walk at a malformed entry and keeps the last good one', () => {
    const headers = { 'x-forwarded-for': '198.51.100.9, junk, 203.0.113.7' };
    expect(resolveClientIp(req(PROXY, headers), 3)).toBe('203.0.113.7');
    // The nearest entry malformed: nothing usable, so the socket address.
    expect(resolveClientIp(req(PROXY, { 'x-forwarded-for': '203.0.113.7, junk' }), 2)).toBe(PROXY);
  });

  it('uses Fly-Client-IP only behind a trusted proxy and only without a usable X-Forwarded-For', () => {
    const fly = { 'fly-client-ip': '203.0.113.7' };
    expect(resolveClientIp(req(PROXY, fly), 1)).toBe('203.0.113.7');
    expect(resolveClientIp(req(PROXY, fly), 0)).toBe(PROXY);
    const both = { ...fly, 'x-forwarded-for': '198.51.100.9' };
    expect(resolveClientIp(req(PROXY, both), 1)).toBe('198.51.100.9');
    expect(resolveClientIp(req(PROXY, { 'fly-client-ip': 'junk' }), 1)).toBe(PROXY);
  });

  it('falls back to the socket address, then to the shared unknown address', () => {
    expect(resolveClientIp(req(PROXY), 1)).toBe(PROXY);
    expect(resolveClientIp(req(undefined), 0)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(req(undefined), 1)).toBe(UNKNOWN_IP);
    expect(resolveClientIp({ headers: {} }, 2)).toBe(UNKNOWN_IP);
    expect(resolveClientIp(req(undefined, { 'x-forwarded-for': '203.0.113.7' }), 1)).toBe(
      '203.0.113.7',
    );
  });

  it.each([-1, MAX_TRUSTED_HOPS + 1, 1.5, Number.NaN])('refuses %d trusted hops', (hops) => {
    expect(() => resolveClientIp(req(PROXY), hops)).toThrow(RangeError);
  });

  it('never lets the client choose the address, whatever it prepends (property)', () => {
    const entry = fc.oneof(fc.ipV4(), fc.ipV6(), fc.string({ maxLength: 40 }));
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 12 }),
        fc.ipV4(),
        fc.integer({ min: 1, max: 3 }),
        (spoofed, client, hops) => {
          // `hops` trusted proxies: the first appends the client, the others the proxy before them.
          const proxies = Array.from({ length: hops - 1 }, (_, i) => `10.0.1.${i + 1}`);
          const chain = [...spoofed.map((s) => s.replace(/,/g, '')), client, ...proxies];
          const headers = { 'x-forwarded-for': chain.join(', ') };
          expect(resolveClientIp(req(PROXY, headers), hops)).toBe(normalizeIp(client));
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

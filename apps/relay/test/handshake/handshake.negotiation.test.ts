/**
 * Negotiation (B038 acceptance 5 and 6; tests "handshake.negotiation.test.ts"): the highest shared
 * protocol, capabilities both sides support (unknown ones ignored), semver comparison including
 * pre-releases, and over a connection: `protocols:[2]` or a client below RELAY_MIN_CLIENT_VERSION
 * is `sys.error` `client_too_old` with an upgrade hint, then close 4426; caps
 * `[resume, compress.zstd, bogus]` are welcomed with `[resume]`.
 */
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  negotiate,
  parseVersion,
  SERVER_PROTOCOLS,
} from '../../src/handshake/negotiate.js';
import { first, handshakeRelay, hello, mintTicket, send, ticketFor } from './helpers.js';

const server = { protocols: [1], caps: ['resume', 'cursor.coalesce'], minClientVersion: '1.2.0' };
const client = (version: string) => ({ name: 'centcom-cli', version });

describe('negotiate', () => {
  it('picks the highest shared protocol and the shared capabilities in server order', () => {
    expect(
      negotiate(
        {
          protocols: [2, 1],
          caps: ['cursor.coalesce', 'bogus', 'resume'],
          client: client('1.2.0'),
        },
        { ...server, protocols: [1, 2] },
      ),
    ).toEqual({ protocol: 2, caps: ['resume', 'cursor.coalesce'] });
    expect(negotiate({ protocols: [1], client: client('2.0.0') }, server)).toEqual({
      protocol: 1,
      caps: [],
    });
  });

  it.each([
    ['no shared protocol', [2], '9.9.9'],
    ['a version below the minimum', [1], '1.1.9'],
    ['a pre-release of the minimum', [1], '1.2.0-rc.1'],
    ['an unparseable version', [1], 'latest'],
  ])('says too_old for %s', (_case, protocols, version) => {
    expect(negotiate({ protocols, client: client(version) }, server)).toBe('too_old');
  });

  it('compares semver versions by precedence', () => {
    const v = (s: string) => {
      const parsed = parseVersion(s);
      if (parsed === undefined) throw new Error(s);
      return parsed;
    };
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.10.0',
      '2.0.0',
    ];
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      expect(compareVersions(v(ordered[i] ?? ''), v(ordered[i + 1] ?? ''))).toBe(-1);
      expect(compareVersions(v(ordered[i + 1] ?? ''), v(ordered[i] ?? ''))).toBe(1);
    }
    expect(compareVersions(v('1.0.0+build.5'), v('1.0.0'))).toBe(0);
    for (const bad of ['1.0', '01.0.0', '1.0.0-', 'v1.0.0', '', 'x'.repeat(70)]) {
      expect(parseVersion(bad)).toBeUndefined();
    }
    expect(parseVersion(7)).toBeUndefined();
  });

  it('speaks protocol 1', () => {
    expect(SERVER_PROTOCOLS).toEqual([1]);
  });
});

describe('negotiation over a connection', () => {
  it.each([
    ['protocols [2] only', { protocols: [2] }],
    [
      'a client older than RELAY_MIN_CLIENT_VERSION',
      { client: { name: 'centcom-cli', version: '0.9.0' } },
    ],
  ])('closes %s with 4426 client_too_old and an upgrade hint', async (_case, p) => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, claims), p));
      const error = await first(c, 'sys.error');
      expect((await c.closed).code).toBe(4426);
      expect(error['p']).toMatchObject({
        code: 'client_too_old',
        status: 426,
        upgrade: { protocols: [1], min_version: '1.0.0' },
      });
      // The ticket was not spent on a client that cannot use it.
      expect(h.access.calls).toBe(0);
    } finally {
      await h.stop();
    }
  });

  it('welcomes with only the capabilities both sides support', async () => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const c = h.open();
      await send(
        c,
        hello(await mintTicket(h.key, claims), { caps: ['resume', 'compress.zstd', 'bogus'] }),
      );
      const welcome = await first(c, 'sys.welcome');
      expect(welcome['p']).toMatchObject({ protocol: 1, caps: ['resume'] });
    } finally {
      await h.stop();
    }
  });
});

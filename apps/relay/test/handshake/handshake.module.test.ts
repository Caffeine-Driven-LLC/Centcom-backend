/**
 * The module's wiring (B038): `handshake/module.ts` is a RelayModule at order 15 that registers one
 * stage there and a connection handler; until B043 provides SessionAccess, a relay running it
 * fails every hello closed (a bad ticket is still 4401; nothing is welcomed). Configuration comes
 * from RELAY_JWKS_URL, RELAY_MIN_CLIENT_VERSION and RELAY_CAPS, with defaults, and refuses bad
 * values.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { unavailableSessionAccess } from '../../src/handshake/access.js';
import {
  DEFAULT_JWKS_URL,
  DEFAULT_MIN_CLIENT_VERSION,
  loadHandshakeConfig,
} from '../../src/handshake/config.js';
import relayModule from '../../src/handshake/module.js';
import { testRelay } from '../helpers.js';
import { first, hello, send } from './helpers.js';
import { connect } from '../helpers.js';

describe('handshake/module.ts', () => {
  it('registers the handshake stage at order 15', async () => {
    expect(relayModule).toMatchObject({ name: 'handshake', order: 15 });
    const relay = await testRelay({ modules: [relayModule] });
    try {
      expect(relay.log.lines().find((l) => l['msg'] === 'relay.module_registered')).toMatchObject({
        module: 'handshake',
        order: 15,
      });
      const c = connect(relay.url);
      await send(c, hello('short'));
      const error = await first(c, 'sys.error');
      expect((await c.closed).code).toBe(4401);
      expect(error['p']).toMatchObject({ code: 'ticket_invalid' });
    } finally {
      await relay.stop();
    }
  });

  it('fails closed until B043 provides SessionAccess', async () => {
    const error = await unavailableSessionAccess
      .resolve('ses_x', 'mem_x', 'dev_x')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'service_unavailable', retryAfterS: 30 });
  });
});

describe('loadHandshakeConfig', () => {
  it('has defaults', () => {
    expect(loadHandshakeConfig({})).toEqual({
      jwksUrl: DEFAULT_JWKS_URL,
      minClientVersion: DEFAULT_MIN_CLIENT_VERSION,
      caps: ['resume', 'cursor.coalesce'],
    });
  });

  it('reads its keys', () => {
    expect(
      loadHandshakeConfig({
        RELAY_JWKS_URL: 'http://localhost:3000/.well-known/jwks.json',
        RELAY_MIN_CLIENT_VERSION: '1.4.0',
        RELAY_CAPS: ' resume , resume,cursor.coalesce ',
      }),
    ).toEqual({
      jwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      minClientVersion: '1.4.0',
      caps: ['resume', 'cursor.coalesce'],
    });
  });

  it.each([
    ['RELAY_JWKS_URL', 'https://api.centcom.dev/jwks?x=1'],
    ['RELAY_JWKS_URL', 'ftp://api.centcom.dev/jwks'],
    ['RELAY_MIN_CLIENT_VERSION', '1.4'],
    ['RELAY_CAPS', 'Resume!'],
  ])('refuses a bad %s', (key, value) => {
    expect(() => loadHandshakeConfig({ [key]: value })).toThrow(ConfigError);
  });
});

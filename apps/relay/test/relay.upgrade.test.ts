/**
 * WebSocket upgrades (B037, card test relay.upgrade.test.ts, acceptance 2): only `centcom.v1`
 * (400 otherwise, echoed when accepted), only `/v1/ws` (404 otherwise), never a `ticket` or
 * `token` in the query (400, and never logged), browser origins only from the allowlist (403),
 * the transport payload guard (close 1009); and the close-code table covers CT-WS-ENVELOPE's.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CloseCode, RELAY_METRICS } from '../src/index.js';
import { connect, testRelay, upgradeStatus, type TestRelay } from './helpers.js';

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

describe('subprotocol and path (acceptance 2)', () => {
  it('refuses an upgrade offering only foo with 400, accepts centcom.v1 and echoes it', async () => {
    relay = await testRelay();
    expect(await upgradeStatus(relay.url, { protocols: ['foo'] })).toBe(400);
    expect(await upgradeStatus(relay.url, { protocols: [] })).toBe(400);
    expect(await upgradeStatus(relay.url, { protocols: ['centcom.v2'] })).toBe(400);
    const client = connect(relay.url);
    await client.opened;
    expect(client.ws.protocol).toBe('centcom.v1');
    const both = connect(relay.url, { protocols: ['foo', 'centcom.v1'] });
    await both.opened;
    expect(both.ws.protocol).toBe('centcom.v1');
    client.ws.close();
    both.ws.close();
  });

  it('answers 404 to an upgrade on any other path', async () => {
    relay = await testRelay();
    const base = `ws://127.0.0.1:${relay.port}`;
    for (const path of ['/', '/v1', '/v1/ws/', '/v1/WS', '/v2/ws', '/v1/ws/extra', '/healthz']) {
      expect(await upgradeStatus(`${base}${path}`)).toBe(404);
    }
    expect(relay.recorded.count(RELAY_METRICS.upgradesRefused, { reason: 'path' })).toBe(7);
  });
});

describe('credentials in the URL', () => {
  it('refuses ?ticket= and ?token= with 400, and never logs them', async () => {
    relay = await testRelay();
    for (const query of [
      '?ticket=sekret-ticket-value',
      '?token=sekret-token-value',
      '?Ticket=sekret-ticket-value',
      '?x=1&TOKEN=sekret-token-value',
    ]) {
      expect(await upgradeStatus(`${relay.url}${query}`)).toBe(400);
    }
    // Other query parameters are not credentials.
    expect(await upgradeStatus(`${relay.url}?region=eu`)).toBe(101);
    expect(
      relay.recorded.count(RELAY_METRICS.upgradesRefused, { reason: 'query_credentials' }),
    ).toBe(4);
    expect(relay.log.raw()).not.toContain('sekret');
    expect(relay.log.raw()).not.toContain('centcom.v1');
  });
});

describe('origins', () => {
  it('lets only clients without an Origin in when the allowlist is empty', async () => {
    relay = await testRelay();
    expect(await upgradeStatus(relay.url)).toBe(101);
    expect(await upgradeStatus(relay.url, { headers: { origin: 'https://app.centcom.dev' } })).toBe(
      403,
    );
  });

  it('lets allowed browser origins in, and refuses the rest with 403', async () => {
    relay = await testRelay({ config: { allowedOrigins: ['https://app.centcom.dev'] } });
    expect(await upgradeStatus(relay.url, { headers: { origin: 'https://app.centcom.dev' } })).toBe(
      101,
    );
    for (const origin of [
      'https://evil.test',
      'http://app.centcom.dev',
      'https://app.centcom.dev.evil.test',
      'null',
    ]) {
      expect(await upgradeStatus(relay.url, { headers: { origin } })).toBe(403);
    }
    expect(await upgradeStatus(relay.url)).toBe(101);
  });
});

describe('the transport guard', () => {
  it('closes a connection that sends more than RELAY_MAX_TRANSPORT_BYTES with 1009', async () => {
    relay = await testRelay({ config: { maxTransportBytes: 262_144 } });
    const client = connect(relay.url);
    await client.opened;
    client.ws.send('x'.repeat(262_145));
    expect((await client.closed).code).toBe(1009);
    const fits = connect(relay.url);
    await fits.opened;
    fits.ws.send('x'.repeat(262_144));
    fits.ws.close(1000);
    expect((await fits.closed).code).toBe(1000);
  });
});

describe('close codes', () => {
  it('has every code of the CT-WS-ENVELOPE table, with its value', () => {
    const contract = readFileSync(
      new URL('../../../contracts/03-ws-envelope.md', import.meta.url),
      'utf8',
    );
    const table = contract.slice(
      contract.indexOf('### Close codes'),
      contract.indexOf('### Reconnection'),
    );
    const codes = [...table.matchAll(/^\| (\d{4}) \|/gm)].map((m) => Number(m[1]));
    expect(codes).toHaveLength(11);
    const values: number[] = Object.values(CloseCode);
    for (const code of codes) expect(values).toContain(code);
    expect(CloseCode).toMatchObject({
      Normal: 1000,
      GoingAway: 1001,
      ProtocolViolation: 4400,
      Unauthenticated: 4401,
      Forbidden: 4403,
      NotFound: 4404,
      HandshakeTimeout: 4408,
      Superseded: 4409,
      ClientTooOld: 4426,
      RateLimited: 4429,
      Overloaded: 4503,
    });
  });
});

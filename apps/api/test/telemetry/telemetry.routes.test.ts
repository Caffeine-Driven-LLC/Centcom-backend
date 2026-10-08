/**
 * `POST /v1/telemetry/events` (B085) on the API's plugin stack (request context, errors, B023's
 * limiter with the route exempt, B017's auth):
 *
 * - every outcome is 204 with an empty body: valid, invalid JSON, over 64 KiB, 101 events, unknown
 *   types, a wrong content type, no auth, valid auth, a bad token; only allow-listed events are
 *   stored (by row count);
 * - privacy: no row holds an address, a `usr_` id or a request id; the access log line has no
 *   user, address or body, and the logger redacts bodies;
 * - linkage: the same batch with and without a bearer token is stored identically;
 * - limits: 12 batches a minute per install, 120 per address; past them dropped (`rate_limited`),
 *   still 204, no `Retry-After`;
 * - failure: Postgres down is 204, the batch dropped, `telemetry_dropped_total{reason=store_error}`;
 * - contract: the `contracts/fixtures/telemetry/` batches; fuzz: random bodies are never non-204.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { batch, event, INSTALL, post, T0, telemetryApp } from './helpers.js';

const FIXTURES = fileURLToPath(
  new URL('../../../../contracts/fixtures/telemetry/', import.meta.url),
);
const fixture = (name: string) =>
  (JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as { data: unknown }).data;

/** The fixture's events moved to a minute before T0 (their times are years old). */
const recent = (data: unknown) => {
  const b = data as { events: { at: string }[] };
  return { ...b, events: b.events.map((e) => ({ ...e, at: new Date(T0 - 60_000).toISOString() })) };
};

describe('always 204', () => {
  it('answers every outcome with 204 and an empty body, storing only allow-listed events', async () => {
    const t = await telemetryApp();
    const valid = batch([event('app.start'), event('command.run', { name: 'login' })]);
    const cases: [
      string,
      Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>,
      number,
    ][] = [
      ['valid', post(t.app, valid), 2],
      ['invalid JSON', post(t.app, '{"install_id": '), 0],
      ['over 64 KiB', post(t.app, JSON.stringify({ ...valid, pad: 'x'.repeat(70 * 1024) })), 0],
      ['over the parse limit', post(t.app, 'x'.repeat(2 * 1024 * 1024)), 0],
      ['101 events', post(t.app, batch(Array.from({ length: 101 }, () => event('app.start')))), 0],
      ['unknown type', post(t.app, batch([event('prompt.sent')])), 0],
      ['wrong content type', post(t.app, valid, { 'content-type': 'text/plain' }), 0],
      [
        'form content type',
        post(t.app, 'a=b', { 'content-type': 'application/x-www-form-urlencoded' }),
        0,
      ],
      ['no body', t.app.inject({ method: 'POST', url: '/v1/telemetry/events' }), 0],
      ['valid auth', post(t.app, valid, await t.bearer()), 2],
      ['bad token', post(t.app, valid, { authorization: 'Bearer not-a-token' }), 2],
      ['malformed auth', post(t.app, valid, { authorization: 'Basic eDp5' }), 2],
    ];
    let rows = 0;
    for (const [name, pending, stored] of cases) {
      const res = await pending;
      expect(res.statusCode, name).toBe(204);
      expect(res.body, name).toBe('');
      expect(res.headers['retry-after'], name).toBeUndefined();
      expect(res.headers['www-authenticate'], name).toBeUndefined();
      rows += stored;
      expect(t.repo.rows, name).toHaveLength(rows);
    }
    // Other methods and paths are not this route's business.
    await t.app.close();
  });

  it('drops command names with paths or URLs as pii_pattern and unknown states as enum_unknown', async () => {
    const t = await telemetryApp();
    const res = await post(
      t.app,
      batch([
        event('command.run', { name: 'open /home/me/repo' }),
        event('command.run', { name: 'https://example.test' }),
        event('agent.state_change', { from: 'idle', to: 'plotting' }),
        event('agent.state_change', { from: 'idle', to: 'thinking' }),
      ]),
    );
    expect(res.statusCode).toBe(204);
    expect(t.repo.rows.map((r) => r.type)).toEqual(['agent.state_change']);
    expect(t.recorded.count('telemetry_dropped_total', { reason: 'pii_pattern' })).toBe(2);
    expect(t.recorded.count('telemetry_dropped_total', { reason: 'enum_unknown' })).toBe(1);
    expect(t.recorded.count('telemetry_accepted_total')).toBe(1);
    await t.app.close();
  });
});

describe('privacy', () => {
  it('stores no address, user id or request id, and logs no user, address or body', async () => {
    const t = await telemetryApp();
    const headers = { ...(await t.bearer()), 'x-request-id': 'req_01HZZZZZZZZZZZZZZZZZZZZZZZ' };
    await post(
      t.app,
      batch(
        [event('command.run', { name: 'login' }), event('error.shown', { code: 'forbidden' })],
        {
          user: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        },
      ),
      headers,
      '198.51.100.23',
    );
    expect(t.repo.rows).toHaveLength(2);
    for (const row of t.repo.rows) {
      expect(Object.keys(row).sort()).toEqual(['at', 'day', 'install_id', 'props', 'type']);
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/198\.51\.100\.23|usr_|req_|@|\/home|Bearer/);
    }
    const lines = t.captured.lines();
    const access = lines.filter((l) => l['msg'] === 'http.request');
    expect(access).toHaveLength(1);
    expect(Object.keys(access[0] ?? {}).sort()).toEqual(
      expect.arrayContaining(['duration_ms', 'method', 'request_id', 'route', 'status']),
    );
    for (const key of ['user', 'user_id', 'ip', 'remote_address', 'body', 'install_id']) {
      expect(access[0], key).not.toHaveProperty(key);
    }
    expect(t.captured.raw()).not.toMatch(
      /198\.51\.100\.23|usr_01JA|"login"|forbidden|01JA3Z8K2M5N7P9Q0R1S2T3V4W"/,
    );
    // Even a careless line cannot carry a body: the logger redacts it.
    t.captured.logger.info({ body: 'secret batch', ip_hash: 'x' }, 'probe');
    expect(t.captured.raw()).not.toContain('secret batch');
    await t.app.close();
  });

  it('stores the same rows for the same batch with and without a bearer token', async () => {
    const t = await telemetryApp();
    const b = batch([event('app.start'), event('feature.used', { key: 'editor.split' })]);
    await post(t.app, b);
    const anonymous = structuredClone(t.repo.rows);
    t.repo.rows = [];
    await post(t.app, b, await t.bearer(), '192.0.2.99');
    expect(t.repo.rows).toEqual(anonymous);
    await t.app.close();
  });
});

describe('limits', () => {
  it('drops a 13th batch a minute per install and a 121st per address, still 204 without Retry-After', async () => {
    const t = await telemetryApp();
    const b = batch([event('app.start')]);
    for (let i = 0; i < 12; i += 1) expect((await post(t.app, b)).statusCode).toBe(204);
    expect(t.repo.rows).toHaveLength(12);
    const limited = await post(t.app, b);
    expect(limited.statusCode).toBe(204);
    expect(limited.headers['retry-after']).toBeUndefined();
    expect(t.repo.rows).toHaveLength(12);
    expect(t.recorded.count('telemetry_dropped_total', { reason: 'rate_limited' })).toBe(1);
    // Another install from the same address is still welcome, until the address's 120.
    const others = Array.from({ length: 120 }, (_, i) =>
      batch([event('app.exit')], {
        install_id: `01JA3Z8K2M5N7P9Q0R1S2T${String(i).padStart(4, '0')}`,
      }),
    );
    for (const other of others.slice(0, 120 - 13)) await post(t.app, other);
    expect(t.repo.rows).toHaveLength(12 + 107);
    const pastAddress = await post(t.app, others[119]);
    expect(pastAddress.statusCode).toBe(204);
    expect(t.repo.rows).toHaveLength(119);
    // Another address is not affected; a minute later the install may send again.
    await post(t.app, others[118], {}, '192.0.2.1');
    expect(t.repo.rows).toHaveLength(120);
    t.clock.now += 61_000;
    await post(t.app, b);
    expect(t.repo.rows).toHaveLength(121);
    await t.app.close();
  });
});

describe('failures', () => {
  it('answers 204 when Postgres is down, dropping the batch with store_error', async () => {
    const t = await telemetryApp();
    t.repo.down = true;
    const res = await post(t.app, batch([event('app.start'), event('app.exit')]));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(t.recorded.count('telemetry_dropped_total', { reason: 'store_error' })).toBe(2);
    expect(t.captured.raw()).toContain('telemetry.store_failed');
    expect(t.captured.raw()).not.toContain('ECONNREFUSED');
    await t.app.close();
  });

  it('answers 204 when the rate-limit store is down, dropping the batch', async () => {
    const t = await telemetryApp();
    t.redis.rateLimit.consume = () => Promise.reject(new Error('redis down'));
    expect((await post(t.app, batch([event('app.start')]))).statusCode).toBe(204);
    expect(t.repo.rows).toEqual([]);
    await t.app.close();
  });
});

describe('contract fixtures', () => {
  it('stores the valid batch, and nothing the invalid ones carry', async () => {
    const t = await telemetryApp();
    await post(t.app, recent(fixture('batch')));
    expect(t.repo.rows.map((r) => [r.type, r.props])).toEqual([
      ['app.start', {}],
      ['command.run', { name: 'login' }],
    ]);
    expect(t.repo.rows[0]?.install_id).toBe(INSTALL);
    t.repo.rows = [];
    // `user` is never stored: the event without it is.
    await post(t.app, recent(fixture('extra_field')));
    expect(JSON.stringify(t.repo.rows)).not.toContain('usr_');
    t.repo.rows = [];
    await post(t.app, recent(fixture('unknown_event')));
    expect(t.repo.rows).toEqual([]);
    await t.app.close();
  });
});

describe('fuzz', () => {
  it('answers 204 to any body, never a 4xx or 5xx', async () => {
    const t = await telemetryApp();
    const bodies = fc.oneof(
      fc.json(),
      fc.string(),
      fc.uint8Array({ maxLength: 512 }).map((a) => Buffer.from(a)),
      fc
        .record({
          install_id: fc.oneof(fc.constant(INSTALL), fc.string()),
          events: fc.array(
            fc.record({
              type: fc.string(),
              at: fc.string(),
              props: fc.dictionary(fc.string(), fc.jsonValue()),
            }),
            { maxLength: 5 },
          ),
        })
        .map((v) => JSON.stringify(v)),
    );
    await fc.assert(
      fc.asyncProperty(
        bodies,
        fc.constantFrom('application/json', 'text/plain', ''),
        async (body, type) => {
          t.clock.now += 61_000; // stay under the limits
          const res = await post(t.app, body, type === '' ? {} : { 'content-type': type });
          expect(res.statusCode).toBe(204);
          expect(res.body).toBe('');
        },
      ),
      { numRuns: 200 },
    );
    await t.app.close();
  });
});

/**
 * Health and status endpoints (B086) on the API's plugin stack:
 *
 * - `/healthz` is 200 `{"status":"ok"}` whatever the dependencies do;
 * - `/readyz` is 200 only with the database, Redis and migrations ready, else 503 naming the
 *   failed checks as `{ok:false}`, without errors, hosts or stack traces, within about 1 s even
 *   when a dependency hangs;
 * - `/v1/status` matches CT-STATUS: worst-of components, probes with hysteresis, open and recent
 *   incidents, `min_client_version` from Redis or the config, `contract_version` from
 *   `contracts/index.json`, `public, max-age=15`, ETag and 304, no authentication;
 * - two instances run at most one probe round per component every 15 s;
 * - a probe target hanging 10 s still gets an answer within 3 s;
 * - Postgres or Redis down: the last feed for up to 5 minutes, then a degraded feed, never 500.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FEED_STALE_MS, MIN_CLIENT_VERSION_KEY } from '../../src/modules/status/service.js';
import { probeTarget, statusWorld, T0, type ProbeTarget, type StatusWorld } from './helpers.js';

let world: StatusWorld | undefined;
let target: ProbeTarget | undefined;
afterEach(async () => {
  await world?.close();
  await target?.close();
  world = undefined;
  target = undefined;
});

const INDEX = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../contracts/index.json', import.meta.url)), 'utf8'),
) as { contract_version: string };

const get = (
  w: {
    app: {
      inject: (o: object) => Promise<{
        statusCode: number;
        body: string;
        headers: Record<string, unknown>;
        json: <T>() => T;
      }>;
    };
  },
  url: string,
  headers: Record<string, string> = {},
) => w.app.inject({ method: 'GET', url, headers });

describe('/healthz', () => {
  it('answers 200 {"status":"ok"} even with Postgres and Redis down', async () => {
    world = statusWorld();
    world.db.mode = 'down';
    world.redisMode.mode = 'down';
    world.repo.down = true;
    const i = await world.instance();
    const res = await get(i, '/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
    expect(validate('api/HealthStatus', res.json()).ok).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('/readyz', () => {
  it('is 200 when everything is ready, else 503 naming each failed check', async () => {
    world = statusWorld();
    const w = world;
    const i = await world.instance();
    const ready = await get(i, '/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ok',
      checks: { db: { ok: true }, redis: { ok: true }, migrations: { ok: true } },
    });

    const cases: [() => void, Record<string, boolean>][] = [
      [() => (w.db.mode = 'down'), { db: false, redis: true, migrations: false }],
      [() => (w.redisMode.mode = 'down'), { db: true, redis: false, migrations: true }],
      [() => (w.db.version = '20260102002700'), { db: true, redis: true, migrations: false }],
      [() => (w.db.mode = 'no_table'), { db: true, redis: true, migrations: false }],
    ];
    for (const [breakIt, expected] of cases) {
      world.db.mode = 'up';
      world.db.version = '20260102002800';
      world.redisMode.mode = 'up';
      breakIt();
      const res = await get(i, '/readyz');
      expect(res.statusCode, JSON.stringify(expected)).toBe(503);
      expect(res.json()).toEqual({
        status: 'degraded',
        checks: Object.fromEntries(Object.entries(expected).map(([k, ok]) => [k, { ok }])),
      });
      expect(res.body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|internal|5432|6379|Error|at /);
    }
    // A database ahead of the build is ready (B007: expand, migrate, contract).
    world.db.mode = 'up';
    world.redisMode.mode = 'up';
    world.db.version = '20991231000000';
    expect((await get(i, '/readyz')).statusCode).toBe(200);
  });

  it('answers within about a second when the database and Redis hang', async () => {
    world = statusWorld();
    world.db.mode = 'slow';
    world.redisMode.mode = 'slow';
    const i = await world.instance();
    const started = performance.now();
    const res = await get(i, '/readyz');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { db: { ok: false }, redis: { ok: false } } });
  });
});

describe('/v1/status', () => {
  it('matches CT-STATUS, takes the worst component, and needs no authentication', async () => {
    target = await probeTarget();
    world = statusWorld([
      { id: 'api', name: 'API', probe: null },
      { id: 'relay-eu', name: 'Relay (EU)', probe: { url: target.url('/eu') } },
      { id: 'relay-us', name: 'Relay (US)', probe: { url: target.url('/us') } },
    ]);
    const w = world;
    await world.redis.kv.set(MIN_CLIENT_VERSION_KEY, '1.3.0');
    await world.repo.setDeprecation({ what: '/v1/legacy', sunset: '2027-03-01' });
    const i = await world.instance();
    const res = await get(i, '/v1/status', { authorization: 'Bearer anything' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    const checked = validate('api/StatusFeed', body);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(body).toEqual({
      status: 'operational',
      updated_at: new Date(T0).toISOString(),
      components: [
        { id: 'api', name: 'API', status: 'operational' },
        { id: 'relay-eu', name: 'Relay (EU)', status: 'operational' },
        { id: 'relay-us', name: 'Relay (US)', status: 'operational' },
      ],
      incidents: [],
      min_client_version: '1.3.0',
      contract_version: INDEX.contract_version,
      deprecations: [{ what: '/v1/legacy', sunset: '2027-03-01' }],
    });
    expect(res.body).not.toContain('127.0.0.1');
    expect(res.headers['cache-control']).toBe('public, max-age=15');

    // One component degraded, then (three failures) a major outage: the feed follows the worst.
    target.modes.set('/eu', 'down');
    const statusAt = async (offsetS: number) => {
      w.clock.now = T0 + offsetS * 1000;
      return (await get(i, '/v1/status')).json<{
        status: string;
        components: { status: string }[];
      }>();
    };
    expect((await statusAt(16)).status).toBe('degraded');
    expect((await statusAt(32)).status).toBe('degraded');
    const outage = await statusAt(48);
    expect(outage.status).toBe('major_outage');
    expect(outage.components[1]?.status).toBe('major_outage');
    // Recovery takes two good rounds.
    target.modes.set('/eu', 'up');
    expect((await statusAt(64)).status).toBe('major_outage');
    expect((await statusAt(80)).status).toBe('operational');
  });

  it('has an ETag, answers If-None-Match with 304, and reuses a feed for 15 s', async () => {
    world = statusWorld([{ id: 'api', name: 'API', probe: null }]);
    const i = await world.instance();
    const first = await get(i, '/v1/status');
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^"s[A-Za-z0-9_-]{22}"$/);
    const cached = await get(i, '/v1/status', { 'if-none-match': etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    expect(world.repo.reads).toBe(1);
    world.clock.now = T0 + 14_999;
    await get(i, '/v1/status');
    expect(world.repo.reads).toBe(1);
    world.clock.now = T0 + 15_000;
    const later = await get(i, '/v1/status', { 'if-none-match': etag });
    expect(later.statusCode).toBe(200);
    expect(world.repo.reads).toBe(2);
  });

  it('follows the Redis minimum client version within 15 s, else the config', async () => {
    world = statusWorld();
    const i = await world.instance();
    const minVersion = async () =>
      (await get(i, '/v1/status')).json<{ min_client_version: string }>().min_client_version;
    expect(await minVersion()).toBe('1.0.0');
    await world.redis.kv.set(MIN_CLIENT_VERSION_KEY, '1.4.0');
    world.clock.now = T0 + 15_000;
    expect(await minVersion()).toBe('1.4.0');
  });

  it('shows open incidents with their updates, and hides ones resolved over 7 days ago', async () => {
    world = statusWorld([{ id: 'relay-eu', name: 'Relay (EU)', probe: null }]);
    const i = await world.instance();
    world.clock.now = T0 - 8 * 86_400_000;
    const old = await i.admin.createIncident({
      title: 'Old',
      component_ids: ['relay-eu'],
      status: 'investigating',
    });
    await i.admin.resolveIncident(old.id);
    world.clock.now = T0 - 3600_000;
    const open = await i.admin.createIncident({
      title: 'Relay errors in EU',
      component_ids: ['relay-eu'],
      status: 'investigating',
    });
    world.clock.now = T0 - 1800_000;
    await i.admin.addIncidentUpdate(open.id, 'We are looking into it.');
    world.clock.now = T0;
    const body = (await get(i, '/v1/status')).json<{
      incidents: { id: string; updates: { text: string }[] }[];
    }>();
    expect(body.incidents).toEqual([
      expect.objectContaining({
        id: open.id,
        title: 'Relay errors in EU',
        status: 'investigating',
        updates: [{ at: new Date(T0 - 1800_000).toISOString(), text: 'We are looking into it.' }],
      }),
    ]);
  });
});

describe('probes', () => {
  it('runs at most one probe round per component every 15 s across two instances', async () => {
    target = await probeTarget();
    world = statusWorld([
      { id: 'a', name: 'A', probe: { url: target.url('/a') } },
      { id: 'b', name: 'B', probe: { url: target.url('/b') } },
    ]);
    const w = world;
    const [one, two] = [await world.instance(), await world.instance()];
    for (let k = 0; k < 5; k += 1) {
      await Promise.all([get(one, '/v1/status'), get(two, '/v1/status')]);
      world.clock.now += 2000;
    }
    expect(Object.fromEntries(target.hits)).toEqual({ '/a': 1, '/b': 1 });
    world.clock.now = T0 + 15_000;
    await Promise.all([get(one, '/v1/status'), get(two, '/v1/status')]);
    expect(Object.fromEntries(target.hits)).toEqual({ '/a': 2, '/b': 2 });
    // The instance that did not probe shows what the other found.
    target.modes.set('/a', 'down');
    world.clock.now = T0 + 30_000;
    await get(one, '/v1/status');
    world.clock.now = T0 + 31_000; // within the round: two reads the shared state
    const fromTwo = await (async () => {
      await two.feed.current();
      w.clock.now = T0 + 46_000;
      return (await get(two, '/v1/status')).json<{
        components: { id: string; status: string }[];
      }>();
    })();
    expect(fromTwo.components.find((c) => c.id === 'a')?.status).toBe('degraded');
  });

  it('answers within 3 s when a probe target hangs for 10 s', async () => {
    target = await probeTarget();
    target.modes.set('/slow', 'hang');
    world = statusWorld([{ id: 'slow', name: 'Slow', probe: { url: target.url('/slow') } }]);
    const i = await world.instance();
    const started = performance.now();
    const res = await get(i, '/v1/status');
    expect(performance.now() - started).toBeLessThan(3000);
    expect(res.json<{ status: string }>().status).toBe('degraded');
  }, 15_000);

  it('reads heartbeat components from Redis', async () => {
    world = statusWorld([
      { id: 'worker', name: 'Jobs', probe: { heartbeat_key: 'worker:heartbeat', max_age_s: 30 } },
    ]);
    const i = await world.instance();
    await world.redis.kv.set('worker:heartbeat', String(T0 - 5000));
    expect((await get(i, '/v1/status')).json<{ status: string }>().status).toBe('operational');
    world.clock.now = T0 + 40_000;
    expect((await get(i, '/v1/status')).json<{ status: string }>().status).toBe('degraded');
  });
});

describe('failures', () => {
  it('serves the last feed for 5 minutes when Postgres is down, then a degraded feed, never 500', async () => {
    world = statusWorld([{ id: 'api', name: 'API', probe: null }]);
    const i = await world.instance();
    const good = await get(i, '/v1/status');
    world.repo.down = true;
    world.clock.now = T0 + FEED_STALE_MS;
    const stale = await get(i, '/v1/status');
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toBe(good.body);
    expect(stale.json<{ updated_at: string }>().updated_at).toBe(new Date(T0).toISOString());
    world.clock.now = T0 + FEED_STALE_MS + 1;
    const degraded = await get(i, '/v1/status');
    expect(degraded.statusCode).toBe(200);
    const body = degraded.json<{ status: string; components: { id: string; status: string }[] }>();
    expect(validate('api/StatusFeed', body).ok).toBe(true);
    expect(body.status).toBe('degraded');
    expect(body.components).toEqual([
      { id: 'api', name: 'API', status: 'degraded' },
      { id: 'status-data', name: 'Status information', status: 'degraded' },
    ]);
    expect(degraded.body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|5432/);
    expect(i.captured.raw()).not.toMatch(/10\.1\.2\.3/);
    // Back with the data.
    world.repo.down = false;
    world.clock.now += 15_000;
    expect((await get(i, '/v1/status')).json<{ status: string }>().status).toBe('operational');
  });

  it('serves the last feed when Redis is down too', async () => {
    world = statusWorld([{ id: 'w', name: 'W', probe: { heartbeat_key: 'w:hb', max_age_s: 60 } }]);
    await world.redis.kv.set('w:hb', String(T0));
    const i = await world.instance();
    const good = await get(i, '/v1/status');
    world.redis.kv.get = () =>
      Promise.reject(new Error('connect ECONNREFUSED redis.internal:6379'));
    world.clock.now = T0 + 20_000;
    const stale = await get(i, '/v1/status');
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toBe(good.body);
  });
});

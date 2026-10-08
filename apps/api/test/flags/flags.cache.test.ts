/**
 * Flag freshness across API processes (B083 test plan "integration" and "failure-path"):
 *
 * - two instances share Postgres (the in-memory repository) and Redis: a kill switch set through
 *   one reaches the other's answers within 1 s by `flags:inv`, and without the message, by the
 *   15 s revision poll;
 * - a cache whose revision differs from the database's is discarded and reloaded;
 * - Postgres down: the last good set is served with its ETag for 5 minutes after it was last
 *   confirmed, then 503 with `retry_after_s`, and answers come back with Postgres;
 * - a stored rule this code does not know serves the flag's default, counts an error, and the
 *   answer still succeeds.
 */
import { validate } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLAGS_CHANNEL,
  FLAGS_POLL_MS,
  FLAGS_STALE_MS,
  parseFlagsMessage,
} from '../../src/modules/flags/cache.js';
import { boolFlag, flagsWorld, getFlags, staff, T0, until, type FlagsWorld } from './helpers.js';

let world: FlagsWorld;
afterEach(async () => {
  await world.close();
});

const flagsOf = async (res: Promise<{ json: <T>() => T }>) =>
  (await res).json<{ flags: Record<string, unknown> }>().flags;

describe('across instances', () => {
  it('reflects a kill switch on every instance within 1 s through flags:inv', async () => {
    world = flagsWorld();
    const a = await world.instance();
    const b = await world.instance();
    await a.admin.setFlag(boolFlag('relay.v2', { public: true }), staff);
    await until(async () => (await flagsOf(getFlags(b.app)))['relay.v2'] === true);

    await a.admin.setFlag(boolFlag('relay.v2', { public: true, kill: true }), staff);
    const elapsed = await until(
      async () => (await flagsOf(getFlags(b.app)))['relay.v2'] === false,
      1000,
    );
    expect(elapsed).toBeLessThan(1000);
    expect((await getFlags(b.app)).json<{ rev: number }>().rev).toBe(2);
    expect(FLAGS_CHANNEL).toBe('flags:inv');
  });

  it('catches a lost message by polling the revision (every 15 s by default)', async () => {
    world = flagsWorld();
    const watcher = await world.instance({ pollMs: 50 });
    expect(await flagsOf(getFlags(watcher.app))).toEqual({});
    // A change written straight to the database: no message is published.
    world.repo.put({ key: 'quiet', public: true, kill: true });
    const elapsed = await until(
      async () => (await flagsOf(getFlags(watcher.app)))['quiet'] === false,
    );
    expect(elapsed).toBeLessThan(1000);
    expect(FLAGS_POLL_MS).toBe(15_000);
  });

  it('discards and reloads a cache whose revision differs from the database', async () => {
    world = flagsWorld();
    const { app, cache } = await world.instance();
    world.repo.put({ key: 'a', public: true });
    const loads = world.repo.loads;
    await cache.poll();
    expect(world.repo.loads).toBe(loads + 1);
    expect(await flagsOf(getFlags(app))).toEqual({ a: true });
    // The same revision: confirmed without a reload.
    await cache.poll();
    expect(world.repo.loads).toBe(loads + 1);
    // A message naming the current revision changes nothing; a malformed one reloads.
    await world.redis.pubsub.publish(FLAGS_CHANNEL, JSON.stringify({ rev: world.repo.revision }));
    await world.redis.pubsub.publish(FLAGS_CHANNEL, 'nonsense');
    await until(() => world.repo.loads === loads + 2);
    expect(parseFlagsMessage('{"rev":3}')).toBe(3);
    expect(parseFlagsMessage('{"rev":-1}')).toBeNull();
  });
});

describe('Postgres down', () => {
  it('serves the last good set with its ETag for 5 minutes, then 503 retry_after_s', async () => {
    world = flagsWorld();
    const { app, admin, cache, recorded } = await world.instance();
    await admin.setFlag(boolFlag('banner', { public: true }), staff);
    await until(() => cache.current()?.rev === 1);
    const good = await getFlags(app);
    const etag = good.headers['etag'];

    world.repo.down = true;
    await cache.poll();
    expect(recorded.count('flags_refresh_failures_total')).toBe(1);
    world.clock.now = T0 + FLAGS_STALE_MS;
    const stale = await getFlags(app);
    expect(stale.statusCode).toBe(200);
    expect(stale.headers['etag']).toBe(etag);
    expect(stale.json()).toEqual(good.json());
    expect((await getFlags(app, { 'if-none-match': String(etag) })).statusCode).toBe(304);

    world.clock.now = T0 + FLAGS_STALE_MS + 1;
    const refused = await getFlags(app);
    expect(refused.statusCode).toBe(503);
    expect(refused.json<{ code: string; retry_after_s: number }>()).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: 5,
    });
    expect(validate('problem', refused.json()).ok).toBe(true);
    // Right after a failed read, requests are refused without waiting on Postgres.
    const loads = world.repo.loads;
    expect((await getFlags(app)).statusCode).toBe(503);
    expect(world.repo.loads).toBe(loads);

    world.repo.down = false;
    world.clock.now += 2000;
    const back = await getFlags(app);
    expect(back.statusCode).toBe(200);
    expect(back.headers['etag']).toBe(etag);
  });

  it('answers 503 before the first load succeeds', async () => {
    world = flagsWorld();
    world.repo.down = true;
    const { app } = await world.instance();
    const res = await getFlags(app);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ retry_after_s: number }>().retry_after_s).toBe(5);
  });
});

describe('broken definitions', () => {
  it('serves the default of a flag with an unknown rule, counts it, and still answers', async () => {
    world = flagsWorld();
    world.repo.put({ key: 'odd', public: true, rules: [{ type: 'moon_phase', phase: 'full' }] });
    world.repo.put({ key: 'fine', public: true });
    const { app, recorded } = await world.instance();
    const res = await getFlags(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ flags: unknown }>().flags).toEqual({ fine: true, odd: false });
    expect(recorded.count('flags_rule_errors_total')).toBe(1);
  });
});

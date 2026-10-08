/**
 * Health endpoints (B037, card test relay.health.test.ts, acceptance 1): `/healthz` answers 200 at
 * once without touching a dependency, even while they are down; `/readyz` answers 200 only when
 * Redis, the database and its migrations are fine, and 503 `degraded` naming the failed check
 * otherwise (within 2 s when a dependency hangs), and while draining. On Postgres 16 and Redis 7
 * (CI), the real probe says ready.
 */
import { createRedis, keyPrefixFor, Secret } from '@centcom/core';
import { healthCheck, type HealthReport } from '@centcom/db';
import { startTestStack, testcontainersRuntime } from '@centcom/testkit';
import { defineConfig, z } from '@centcom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { dependencyProbe, READINESS_TIMEOUT_MS } from '../src/index.js';
import { stubProbe, testRelay, type TestRelay } from './helpers.js';

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

const get = async (
  base: string,
  path: string,
): Promise<{ status: number; body: unknown; ms: number }> => {
  const started = performance.now();
  const res = await fetch(`${base}${path}`);
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body, ms: performance.now() - started };
};

const REPORT: HealthReport = {
  ok: true,
  migrationsAtExpected: true,
  expectedVersion: '20260102000800',
  currentVersion: '20260102000800',
};

describe('GET /healthz', () => {
  it('answers 200 {"status":"ok"} in under 10 ms while every dependency is down, never probing', async () => {
    const probe = stubProbe({ redis: { ok: false }, db: { ok: false }, migrations: { ok: false } });
    relay = await testRelay({ probe });
    const callsAtStart = probe.calls;
    probe.hang = true; // a probe now would never answer
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await get(relay.base, '/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      times.push(res.ms);
    }
    times.sort((a, b) => a - b);
    expect(times[10]).toBeLessThan(10);
    expect(probe.calls).toBe(callsAtStart);
  });

  it('answers 404 for other paths and methods, and 426 for a plain GET of /v1/ws', async () => {
    relay = await testRelay();
    expect((await fetch(`${relay.base}/`)).status).toBe(404);
    expect((await fetch(`${relay.base}/healthz`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${relay.base}/v1/status`)).status).toBe(404);
    expect((await fetch(`${relay.base}/v1/ws`)).status).toBe(426);
  });
});

describe('GET /readyz', () => {
  it('answers 200 when every check passes', async () => {
    relay = await testRelay({
      probe: stubProbe({ redis: { ok: true }, db: { ok: true }, migrations: { ok: true } }),
    });
    expect(await get(relay.base, '/readyz')).toMatchObject({
      status: 200,
      body: {
        status: 'ok',
        checks: { redis: { ok: true }, db: { ok: true }, migrations: { ok: true } },
      },
    });
  });

  it.each([
    [
      'redis down',
      { ok: true },
      false,
      { redis: { ok: false }, db: { ok: true }, migrations: { ok: true } },
    ],
    [
      'db down',
      { ok: false, migrationsAtExpected: false },
      true,
      { redis: { ok: true }, db: { ok: false }, migrations: { ok: false } },
    ],
    [
      'migrations behind',
      { ok: true, migrationsAtExpected: false },
      true,
      { redis: { ok: true }, db: { ok: true }, migrations: { ok: false } },
    ],
  ] as const)('answers 503 degraded with %s', async (_name, db, redisUp, checks) => {
    relay = await testRelay({
      probe: Object.assign(
        dependencyProbe({
          redis: { ping: () => (redisUp ? Promise.resolve() : Promise.reject(new Error('down'))) },
          db: () => Promise.resolve({ ...REPORT, ...db }),
        }),
        { checks: {}, calls: 0, hang: false },
      ),
    });
    const res = await get(relay.base, '/readyz');
    expect(res).toMatchObject({ status: 503, body: { status: 'degraded', checks } });
    expect(JSON.stringify(res.body)).not.toMatch(/error|down|redis:\/\//i);
  });

  it('answers 503 with checks.redis.ok false within 2 s when Redis does not answer', async () => {
    const probe = dependencyProbe({
      redis: { ping: () => new Promise<void>(() => undefined) },
      db: () => new Promise<HealthReport>(() => undefined),
    });
    relay = await testRelay({ probe: Object.assign(probe, { checks: {}, calls: 0, hang: false }) });
    const res = await get(relay.base, '/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ checks: { redis: { ok: false }, db: { ok: false } } });
    expect(res.ms).toBeLessThan(2_000);
    expect(res.ms).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 50);
  }, 10_000);

  it('answers 503 while draining, without probing, and readiness turns false', async () => {
    relay = await testRelay();
    expect((await get(relay.base, '/readyz')).status).toBe(200);
    expect(relay.readiness.ready).toBe(true);
    const calls = relay.probe.calls;
    relay.server.beginDrain();
    expect(await get(relay.base, '/readyz')).toMatchObject({
      status: 503,
      body: { status: 'degraded', checks: { draining: { ok: false } } },
    });
    expect(relay.probe.calls).toBe(calls);
    expect(relay.readiness.ready).toBe(false);
  });

  it('follows the dependencies as they come and go', async () => {
    const probe = stubProbe({ redis: { ok: false } });
    relay = await testRelay({ probe });
    expect((await get(relay.base, '/readyz')).status).toBe(503);
    expect(relay.readiness.ready).toBe(false);
    probe.checks = { redis: { ok: true } };
    expect((await get(relay.base, '/readyz')).status).toBe(200);
    expect(relay.readiness.ready).toBe(true);
  });
});

const env = defineConfig(
  z.object({ DATABASE_URL: z.string().optional(), REDIS_URL: z.string().optional() }),
);
const STACK =
  (env.DATABASE_URL !== undefined && env.REDIS_URL !== undefined) ||
  (await testcontainersRuntime.check().then(
    () => true,
    () => false,
  ));

describe.runIf(STACK)('readiness on Postgres 16 and Redis 7', () => {
  it('is ready with the real probe over a migrated database and a live Redis', async () => {
    const stack = await startTestStack();
    const redis = createRedis({ url: new Secret(stack.redisUrl), keyPrefix: keyPrefixFor('test') });
    try {
      const probe = dependencyProbe({ redis, db: () => healthCheck(stack.db) });
      expect(await probe.check()).toEqual({
        redis: { ok: true },
        db: { ok: true },
        migrations: { ok: true },
      });
      relay = await testRelay({
        probe: Object.assign(probe, { checks: {}, calls: 0, hang: false }),
      });
      expect((await get(relay.base, '/readyz')).status).toBe(200);
    } finally {
      await redis.close();
      await stack.stop();
    }
  }, 180_000);
});

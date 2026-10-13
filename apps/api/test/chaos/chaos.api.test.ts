/**
 * Failure-mode experiments on the API (B096), run with `pnpm chaos` (they need Docker or
 * DATABASE_URL/REDIS_URL, and are skipped in a normal `pnpm test`): Redis down, Postgres down,
 * Postgres slow, a hung (partitioned) backend, and a Postgres crash and restart, each against the
 * policy table in docs/ops/failure-modes.md. A fault is injected with the proxies of `proxy.ts`
 * (or by killing a container), the steady state is probed before, during and after, and a write
 * ledger proves that no create the API acknowledged is missing afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAOS_ON,
  OUTAGE_S,
  record,
  sleep,
  startNode,
  within,
  type Node,
  type ScenarioReport,
} from './harness.js';

/** Probes a node and returns what the policy table speaks about. */
async function probe(node: Node) {
  const [health, ready, me, usage] = await Promise.all([
    node.app.inject({ method: 'GET', url: '/healthz' }),
    node.app.inject({ method: 'GET', url: '/readyz' }),
    node.get('/v1/me'),
    node.post('/v1/usage/events', { events: [] }),
  ]);
  return {
    healthz: health.statusCode,
    readyz: ready.statusCode,
    me: me.statusCode,
    usage: usage.statusCode,
    usageRetryAfter: usage.headers['retry-after'] ?? null,
  };
}

describe.runIf(CHAOS_ON)('failure modes of one API node', () => {
  let node: Node;
  beforeAll(async () => {
    node = await startNode();
  }, 120_000);
  afterAll(async () => {
    await node.stop();
  });

  it('steady state: healthy, ready, signed in, and writes are acknowledged', async () => {
    const before = await probe(node);
    expect(before).toMatchObject({ healthz: 200, readyz: 200, me: 200 });
    expect((await node.createWorkspace()).statusCode).toBe(201);
  });

  describe.each(['refuse', 'blackhole'] as const)('Redis down (%s)', (fault) => {
    it('degrades as documented, and recovers within 30 s', async () => {
      const report: ScenarioReport = {
        scenario: `redis-${fault}`,
        passed: false,
        steady_state_before: await probe(node),
        during: {},
        after: {},
        violations: [],
      };
      node.redisProxy.set(fault);
      // /readyz reports 503 within 15 s; /healthz stays up (liveness never depends on a backend).
      const notReady = await within(15_000, async () => (await probe(node)).readyz === 503);
      expect(notReady, 'readyz 503 within 15 s').not.toBeNull();
      await sleep(OUTAGE_S * 1000);
      const during = await probe(node);
      report.during = { ...during, readyzAfterMs: notReady };
      expect(during.healthz).toBe(200);
      // Rate limits and caches fail open: a signed-in read still works, only slower.
      expect(during.me).toBe(200);
      // A route that promises "never run twice" (required Idempotency-Key) fails closed, retriably.
      expect(during.usage).toBe(503);
      expect(during.usageRetryAfter).not.toBeNull();
      node.redisProxy.set('pass');
      const recovered = await within(30_000, async () => {
        const p = await probe(node);
        return p.readyz === 200 && p.usage !== 503;
      });
      report.after = { recoveredAfterMs: recovered, ...(await probe(node)) };
      expect(recovered, 'recovered within 30 s').not.toBeNull();
      // Idempotency works again: the same key twice runs once and replays.
      const key = crypto.randomUUID();
      const first = await node.post('/v1/workspaces', { name: `after ${fault}` }, key);
      const second = await node.post('/v1/workspaces', { name: `after ${fault}` }, key);
      expect(first.statusCode).toBe(201);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
      report.passed = true;
      record(report);
    }, 180_000);
  });

  describe.each([
    ['refuse', 0],
    ['blackhole', 0],
    ['delay', 1500],
  ] as const)('Postgres %s', (fault, delayMs) => {
    it('answers 503 with Retry-After, never an acknowledged write that is lost, and recovers', async () => {
      const report: ScenarioReport = {
        scenario: `postgres-${fault}`,
        passed: false,
        steady_state_before: await probe(node),
        during: {},
        after: {},
        violations: [],
      };
      node.dbProxy.set(fault, delayMs);
      const notReady = await within(15_000, async () => (await probe(node)).readyz === 503);
      expect(notReady, 'readyz 503 within 15 s').not.toBeNull();
      const writes: number[] = [];
      const end = Date.now() + OUTAGE_S * 1000;
      while (Date.now() < end) {
        const res = await node.createWorkspace();
        writes.push(res.statusCode);
        if (res.statusCode === 503) expect(res.headers['retry-after']).toBeDefined();
        await sleep(200);
      }
      const during = await probe(node);
      report.during = { ...during, writeStatuses: [...new Set(writes)] };
      expect(during.healthz).toBe(200);
      // Unavailable means 503, not 200 with a write that never happened.
      expect(writes.every((s) => s === 503 || s === 201)).toBe(true);
      node.dbProxy.set('pass');
      const recovered = await within(
        30_000,
        async () => (await node.createWorkspace()).statusCode === 201,
      );
      report.after = { recoveredAfterMs: recovered };
      expect(recovered, 'writes resume within 30 s').not.toBeNull();
      // The write ledger: every create the API acknowledged (201) is in Postgres.
      const lost = await node.lost();
      report.violations = lost.map((id) => `acknowledged write missing: ${id}`);
      expect(lost).toEqual([]);
      report.passed = true;
      record(report);
    }, 180_000);
  });
});

/**
 * Signalling delay (B076 acceptance 7: "Signalling delay from the aggregate update to the Redis
 * publish is <= 15 s p95 in the integration test (60 s sweep is only the backstop)"; Postgres 16
 * and Redis 7, CI's integration job):
 *
 * 20 workspaces' usage moves past 80 % (B075's counters on Postgres); right after each update the
 * aggregator's crossing check runs through `withQuotaSignals`, which queues the workspace's
 * `evaluate` job on the real `quota-signals` queue with the default 10 s debounce; a real worker
 * runs `QuotaSignals.evaluateQuota`, which publishes on `relay:notice:{wsp}` through B009's Redis
 * pub/sub, where a subscriber notes the arrival. No sweep runs. The 95th percentile of update to
 * arrival is at most 15 s, and every workspace gets exactly one notice.
 *
 * The usage and the evaluations sit in the fixed October 2026 period (the evaluations' clock is
 * the fixtures' NOW), so a run across a month boundary reads the same period; only the delays are
 * measured in real time.
 */
import { randomBytes } from 'node:crypto';
import {
  createRedis,
  defineConfig,
  keyPrefixFor,
  Secret,
  z,
  type RedisBackend,
} from '@centcom/core';
import type { QuotaSignalsDb } from '@centcom/db';
import {
  createQuotaSignalsDeadQueue,
  createQuotaSignalsQueue,
  enqueueQuotaEvaluate,
  startQuotaSignalsWorker,
} from '@centcom/worker';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { pubsubNotices } from '../../../src/modules/billing/quota/delivery.js';
import { QuotaSignals } from '../../../src/modules/billing/quota/service.js';
import { memoryQuotaStateCache } from '../../../src/modules/billing/quota/state-cache.js';
import { createQuotaSignalStore } from '../../../src/modules/billing/quota/store.js';
import { withQuotaSignals } from '../../../src/modules/billing/quota/triggers.js';
import { createCounterStore } from '../../../src/modules/usage/counters.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgUser,
  pgWorkspace,
} from '../../notifications/dispatcher/postgres.js';
import {
  NOW,
  PERIOD,
  recordingNotify,
  recordingWebhooks,
  scriptedEntitlements,
} from './helpers.js';

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;
const WORKSPACES = 20;

/** BullMQ's connection options from a redis:// URL (ioredis is the worker's dependency). */
function connectionOf(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username === '' ? {} : { username: decodeURIComponent(u.username) }),
    ...(u.password === '' ? {} : { password: decodeURIComponent(u.password) }),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    maxRetriesPerRequest: null,
  };
}

describe.runIf(ADMIN_URL !== undefined && REDIS_URL !== undefined)('quota signal delay', () => {
  it('publishes within 15 s (p95) of the aggregate update, once per workspace', async () => {
    const t = await migratedDatabase(20);
    const redis: RedisBackend = createRedis({
      url: new Secret(REDIS_URL ?? ''),
      keyPrefix: keyPrefixFor('test'),
    });
    const connection = connectionOf(REDIS_URL ?? '');
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const queue = createQuotaSignalsQueue({ connection, prefix });
    const dead = createQuotaSignalsDeadQueue({ connection, prefix });
    const stops: (() => Promise<unknown>)[] = [];
    try {
      const db = t.db as unknown as Kysely<QuotaSignalsDb>;
      const counters = createCounterStore(db);
      const entitlements = scriptedEntitlements();
      const signals = new QuotaSignals({
        store: createQuotaSignalStore(db),
        counters,
        entitlements: entitlements.port,
        cache: memoryQuotaStateCache(() => NOW.getTime()).cache,
        notices: pubsubNotices(redis.pubsub),
        notify: recordingNotify().port,
        emitWebhook: recordingWebhooks().emit,
        clock: () => NOW.getTime(),
      });
      const worker = startQuotaSignalsWorker({
        connection,
        prefix,
        deadLetter: dead,
        evaluate: (ws) => signals.evaluateQuota(ws),
        sweep: () => Promise.resolve(0),
      });
      stops.push(() => worker.close());
      const trigger = withQuotaSignals({ detectCrossings: () => Promise.resolve([]) }, (ws) =>
        enqueueQuotaEvaluate(queue, ws),
      );

      const owner = await pgUser(t.db);
      const updatedAt = new Map<string, number>();
      const heardAt = new Map<string, number[]>();
      const workspaces: string[] = [];
      for (let i = 0; i < WORKSPACES; i += 1) {
        const ws = await pgWorkspace(t.db, owner);
        workspaces.push(ws);
        entitlements.set(ws, {}, PERIOD);
        heardAt.set(ws, []);
        stops.push(
          await redis.pubsub.subscribe(`relay:notice:${ws}`, () =>
            heardAt.get(ws)?.push(Date.now()),
          ),
        );
      }
      for (const ws of workspaces) {
        await counters.add([
          {
            workspaceId: ws,
            periodStart: new Date(PERIOD.start),
            metric: 'relay.hosted_minutes',
            amount: 4800,
          },
        ]);
        updatedAt.set(ws, Date.now());
        await trigger.detectCrossings(ws, new Date());
        // A second update right after: the debounce keeps one evaluation.
        await trigger.detectCrossings(ws, new Date());
      }
      const deadline = Date.now() + 45_000;
      while ([...heardAt.values()].some((h) => h.length === 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const delays = workspaces
        .map((ws) => (heardAt.get(ws)?.[0] ?? Infinity) - (updatedAt.get(ws) ?? 0))
        .sort((a, b) => a - b);
      const p95 = delays[Math.ceil(delays.length * 0.95) - 1] ?? Infinity;
      expect(p95).toBeLessThanOrEqual(15_000);
      expect(workspaces.map((ws) => heardAt.get(ws)?.length)).toEqual(Array(WORKSPACES).fill(1));
    } finally {
      for (const stop of stops.reverse()) await stop();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await dead.close();
      await redis.close();
      await t.drop();
    }
  }, 90_000);
});

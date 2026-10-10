/**
 * Quota signals on Postgres 16 (B076 test plan "integration: concurrent evaluate calls produce one
 * row, one publish, one notification (Postgres + Redis containers)" and "integration: period
 * rollover and limit-raise re-arm behaviour"; DATABASE_URL, CI's integration job; Redis 7 when
 * REDIS_URL is set, else B009's in-memory pub/sub), with B075's counter store:
 *
 * - 10 concurrent evaluations at 80 %: one `quota_signal_state` row (holding the limit it was
 *   claimed under), one notice on `relay:notice:{wsp}` (counted by a subscriber), one
 *   notification, one webhook, with nothing delivered afterwards; the row's delivery steps are all
 *   marked; claiming the same key again is refused by the primary key;
 * - a raised limit re-arms (the rows go), a new period starts with none, and the next crossings
 *   signal again, a re-armed level's notification with a new dedupe key; the old period's rows
 *   stay;
 * - delivery holds no transaction: with Postgres ending sessions idle in a transaction after
 *   500 ms, a notification that takes 1.5 s keeps the notice's mark, and the retry after a failed
 *   webhook sends the webhook alone;
 * - a delivery while another delivery or a decision holds the workspace's lock skips; a decision
 *   waits for a running delivery; the session lock is given back (also when the delivery throws);
 *   a mark never overwrites one;
 * - acceptance 8 on Redis 7: another client reads `reached` from the hash (which exists: not the
 *   SQL fallback) within 1 s of the decision's commit, and a rebuild from SQL never replaces it;
 *   the period ends in 2099, so the hash's expiry is in the future whatever the date of the run;
 * - sweep candidates: meters moved recently, deliveries still to do, a period that just ended;
 *   pages by id;
 * - a deleted workspace takes its rows with it; the CHECK constraints refuse unknown limits and
 *   levels.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createMemoryRedis,
  createRedis,
  defineConfig,
  keyPrefixFor,
  Secret,
  z,
  type RedisBackend,
} from '@centcom/core';
import { closeDb, createDb, type QuotaSignalsDb } from '@centcom/db';
import {
  createQuotaStateRedisClient,
  createRedisQuotaStateCache,
  quotaStateRedisKey,
} from '@centcom/worker';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pubsubNotices } from '../../../src/modules/billing/quota/delivery.js';
import { QuotaSignals } from '../../../src/modules/billing/quota/service.js';
import {
  memoryQuotaStateCache,
  type QuotaStateCache,
} from '../../../src/modules/billing/quota/state-cache.js';
import {
  createQuotaSignalStore,
  QUOTA_LOCK_CLASS,
  type QuotaSignalStore,
} from '../../../src/modules/billing/quota/store.js';
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

async function setup(redis: RedisBackend) {
  const t = await migratedDatabase(20);
  const db = t.db as unknown as Kysely<QuotaSignalsDb>;
  const owner = await pgUser(t.db);
  const ws = await pgWorkspace(t.db, owner);
  const counters = createCounterStore(db);
  const store = createQuotaSignalStore(db);
  const entitlements = scriptedEntitlements();
  entitlements.set(ws);
  const notify = recordingNotify();
  const webhooks = recordingWebhooks();
  /** A QuotaSignals over this database, the workspace's entitlements and `redis`. */
  const signalsWith = (
    over: {
      store?: QuotaSignalStore;
      cache?: QuotaStateCache;
      notify?: ReturnType<typeof recordingNotify>;
      webhooks?: ReturnType<typeof recordingWebhooks>;
      counters?: ReturnType<typeof createCounterStore>;
    } = {},
  ) =>
    new QuotaSignals({
      store: over.store ?? store,
      counters: over.counters ?? counters,
      entitlements: entitlements.port,
      cache: over.cache ?? memoryQuotaStateCache(() => NOW.getTime()).cache,
      notices: pubsubNotices(redis.pubsub),
      notify: (over.notify ?? notify).port,
      emitWebhook: (over.webhooks ?? webhooks).emit,
      clock: () => NOW.getTime(),
    });
  const signals = signalsWith();
  const heard: string[] = [];
  const stop = await redis.pubsub.subscribe(`relay:notice:${ws}`, (m) => heard.push(m));
  const use = (hosted: number, periodStart = new Date(PERIOD.start)) =>
    counters.add([
      { workspaceId: ws, periodStart, metric: 'relay.hosted_minutes', amount: hosted },
    ]);
  const rows = () =>
    db
      .selectFrom('quota_signal_state')
      .selectAll()
      .where('workspace_id', '=', ws)
      .orderBy('period_start')
      .orderBy('level')
      .execute();
  return {
    t,
    db,
    ws,
    owner,
    store,
    signals,
    signalsWith,
    entitlements,
    notify,
    webhooks,
    heard,
    stop,
    use,
    rows,
  };
}

/** Waits for pub/sub messages to arrive. */
const settle = () => sleep(200);

/** A promise and the function that resolves it. */
function gate() {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe.runIf(ADMIN_URL !== undefined)('quota signals on Postgres 16', () => {
  let redis: RedisBackend;
  beforeAll(() => {
    redis =
      REDIS_URL === undefined
        ? createMemoryRedis()
        : createRedis({ url: new Secret(REDIS_URL), keyPrefix: keyPrefixFor('test') });
  });
  afterAll(async () => {
    await redis.close();
  });

  it('makes one row, one notice, one notification and one webhook from 10 concurrent evaluations', async () => {
    const s = await setup(redis);
    try {
      await s.use(4800);
      const runs = await Promise.all(
        Array.from({ length: 10 }, () => s.signals.evaluateQuota(s.ws, NOW)),
      );
      expect(runs.flat()).toHaveLength(1);
      // The evaluations delivered everything themselves.
      expect(await s.signals.deliver(s.ws, NOW)).toBe(0);
      await settle();
      const stored = await s.rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        limit_key: 'hosted_minutes_month',
        level: 'warn',
        limit_value: '6000',
      });
      expect(stored[0]?.period_end.toISOString()).toBe(PERIOD.end);
      expect(stored[0]?.fired_at).not.toBeNull();
      expect(stored[0]?.notified_at).not.toBeNull();
      expect(stored[0]?.webhook_at).not.toBeNull();
      expect(s.heard.map((m) => JSON.parse(m) as unknown)).toEqual([
        { code: 'usage_warning', level: 'warn', params: { pct: 80, resets_at: PERIOD.end } },
      ]);
      expect(s.notify.events).toHaveLength(1);
      expect(s.webhooks.events).toHaveLength(1);
      // The primary key on its own refuses a second claim of the same level.
      expect(
        await s.store.decide(s.ws, (tx) =>
          tx.claim({
            limitKey: 'hosted_minutes_month',
            level: 'warn',
            periodStart: new Date(PERIOD.start),
            periodEnd: new Date(PERIOD.end),
            limitValue: 6000,
          }),
        ),
      ).toBe(false);
    } finally {
      await s.stop();
      await s.t.drop();
    }
  }, 60_000);

  it('re-arms on a raised limit and a new period, and keeps the old period’s rows', async () => {
    const s = await setup(redis);
    try {
      await s.use(6000);
      await s.signals.evaluateQuota(s.ws, NOW);
      expect((await s.rows()).map((r) => r.level).sort()).toEqual(['reached', 'warn']);
      expect(await s.store.levels(s.ws, new Date(PERIOD.start))).toEqual({
        hosted_minutes_month: 'reached',
      });

      s.entitlements.set(s.ws, { hosted_minutes_month: 7000 }); // 85 %: reached re-arms
      expect(await s.signals.evaluateQuota(s.ws, NOW)).toEqual([
        { limit: 'hosted_minutes_month', from: 'reached', to: 'warn', pct: 85 },
      ]);
      expect((await s.rows()).map((r) => `${r.level}@${r.limit_value}`)).toEqual(['warn@6000']);
      await s.use(1000); // 7 000: reached again
      await s.signals.evaluateQuota(s.ws, NOW);
      expect((await s.rows()).map((r) => `${r.level}@${r.limit_value}`).sort()).toEqual([
        'reached@7000',
        'warn@6000',
      ]);
      const [, first, second] = s.notify.events;
      expect(first?.category).toBe('quota_reached');
      expect(second?.category).toBe('quota_reached');
      expect(second?.dedupeKey).not.toBe(first?.dedupeKey);

      const november = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };
      const later = new Date('2026-11-03T00:00:00.000Z');
      s.entitlements.set(s.ws, { hosted_minutes_month: 7000 }, november);
      await s.use(5600, new Date(november.start));
      expect(await s.signals.evaluateQuota(s.ws, later)).toEqual([
        { limit: 'hosted_minutes_month', from: 'ok', to: 'warn', pct: 80 },
      ]);
      await settle();
      const all = await s.rows();
      expect(all.map((r) => `${r.period_start.toISOString().slice(0, 7)}/${r.level}`)).toEqual([
        '2026-10/reached',
        '2026-10/warn',
        '2026-11/warn',
      ]);
      expect(s.heard.map((m) => (JSON.parse(m) as { code: string }).code)).toEqual([
        'usage_warning',
        'quota_reached',
        'quota_reached',
        'usage_warning',
      ]);
    } finally {
      await s.stop();
      await s.t.drop();
    }
  }, 60_000);

  it('keeps the marks of sends that went out when a later send outlasts the idle-transaction cut', async () => {
    const s = await setup(redis);
    // The store on a pool whose sessions Postgres ends after 500 ms idle inside a transaction.
    const strict = createDb<QuotaSignalsDb>({
      url: s.t.url,
      poolMax: 4,
      idleInTransactionTimeoutMs: 500,
      applicationName: 'api-quota-test',
    });
    try {
      const notify = recordingNotify();
      const webhooks = recordingWebhooks();
      const signals = s.signalsWith({
        store: createQuotaSignalStore(strict),
        counters: createCounterStore(strict),
        notify,
        webhooks,
      });
      // Opens the pool's connections: nothing to signal yet.
      await s.use(4799);
      expect(await signals.evaluateQuota(s.ws, NOW)).toEqual([]);

      await s.use(1); // 80 %
      const publish = notify.port.publish;
      notify.port.publish = async (event) => {
        await sleep(1500); // three times the cut
        return publish(event);
      };
      webhooks.failures.push(new Error('connect ECONNREFUSED'));
      await expect(signals.evaluateQuota(s.ws, NOW)).rejects.toMatchObject({ step: 'webhook' });
      const [row] = await s.rows();
      expect(row?.fired_at).not.toBeNull();
      expect(row?.notified_at).not.toBeNull();
      expect(row?.webhook_at).toBeNull();

      // The job's retry: the webhook alone.
      expect(await signals.deliver(s.ws, NOW)).toBe(1);
      await settle();
      expect(s.heard).toHaveLength(1);
      expect(notify.events).toHaveLength(1);
      expect(webhooks.events).toHaveLength(1);
      expect((await s.rows())[0]?.webhook_at).not.toBeNull();
    } finally {
      await closeDb(strict);
      await s.stop();
      await s.t.drop();
    }
  }, 60_000);

  it('skips a delivery while a delivery or a decision holds the lock, and gives the lock back', async () => {
    const s = await setup(redis);
    const release = gate();
    const locked = gate();
    const holdDecision = gate();
    const deciderIn = gate();
    const running: Promise<unknown>[] = [];
    const held = () =>
      sql<{ n: number }>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and classid = ${QUOTA_LOCK_CLASS} and granted
          and database = (select oid from pg_database where datname = current_database())
      `.execute(s.db);
    try {
      // A delivery holds it: another delivery skips, and a decision waits for it.
      const delivering = s.store.deliver(s.ws, async () => {
        locked.open();
        await release.opened;
        return 'first';
      });
      running.push(delivering);
      await locked.opened;
      expect((await held()).rows[0]?.n).toBe(1);
      expect(await s.store.deliver(s.ws, () => Promise.resolve('ran'))).toEqual({ ran: false });
      let decided = false;
      const deciding = s.store.decide(s.ws, () => {
        decided = true;
        return Promise.resolve('decided');
      });
      running.push(deciding);
      await sleep(300);
      expect(decided).toBe(false);
      release.open();
      expect(await delivering).toEqual({ ran: true, value: 'first' });
      expect(await deciding).toBe('decided');
      expect((await held()).rows[0]?.n).toBe(0);

      // A decision holds it: a delivery skips.
      const decision = s.store.decide(s.ws, async () => {
        deciderIn.open();
        await holdDecision.opened;
      });
      running.push(decision);
      await deciderIn.opened;
      expect(await s.store.deliver(s.ws, () => Promise.resolve('ran'))).toEqual({ ran: false });
      holdDecision.open();
      await decision;
      expect(await s.store.deliver(s.ws, () => Promise.resolve('ran'))).toEqual({
        ran: true,
        value: 'ran',
      });

      // A delivery that throws gives the lock back too.
      await expect(
        s.store.deliver(s.ws, () => Promise.reject(new Error('send failed'))),
      ).rejects.toThrow('send failed');
      expect((await held()).rows[0]?.n).toBe(0);

      // A mark never replaces an earlier one.
      await s.store.decide(s.ws, (tx) =>
        tx.claim({
          limitKey: 'queue_items_month',
          level: 'warn',
          periodStart: new Date(PERIOD.start),
          periodEnd: new Date(PERIOD.end),
          limitValue: 1000,
        }),
      );
      const first = new Date('2026-10-15T12:00:00.000Z');
      const again = new Date('2026-10-15T12:05:00.000Z');
      await s.store.deliver(s.ws, async (tx) => {
        const [row] = await tx.pending();
        if (row === undefined) throw new Error('no pending row');
        await tx.mark(row, 'notice', first);
        await tx.mark(row, 'notice', again);
      });
      expect((await s.rows())[0]?.fired_at?.toISOString()).toBe(first.toISOString());
    } finally {
      // A failed assertion must not leave a connection held (dropping the database waits for it).
      release.open();
      holdDecision.open();
      await Promise.allSettled(running);
      await s.stop();
      await s.t.drop();
    }
  }, 60_000);

  it.runIf(REDIS_URL !== undefined)(
    'answers reached from the Redis hash within 1 s of the decision, and keeps it over a rebuild',
    async () => {
      const s = await setup(redis);
      const keyPrefix = keyPrefixFor('test');
      const writer = createQuotaStateRedisClient({ url: new Secret(REDIS_URL ?? ''), keyPrefix });
      const reader = createQuotaStateRedisClient({ url: new Secret(REDIS_URL ?? ''), keyPrefix });
      try {
        // Another process: its own connection, reading as B080 would.
        const other = s.signalsWith({ cache: createRedisQuotaStateCache(reader) });
        let elapsed = Infinity;
        let seen: unknown = null;
        const timed: QuotaSignalStore = {
          ...s.store,
          async decide(workspaceId, fn) {
            const value = await s.store.decide(workspaceId, fn);
            const committed = performance.now();
            seen = await other.getQuotaState(workspaceId);
            elapsed = performance.now() - committed;
            return value;
          },
        };
        const signals = s.signalsWith({ store: timed, cache: createRedisQuotaStateCache(writer) });
        // A period around NOW that ends long after any run: the hash expires an hour after it.
        s.entitlements.set(s.ws, {}, { start: PERIOD.start, end: '2099-01-01T00:00:00.000Z' });
        await s.use(6000);
        await signals.evaluateQuota(s.ws, NOW);
        expect(seen).toEqual({ hosted_minutes_month: 'reached', queue_items_month: 'ok' });
        expect(elapsed).toBeLessThan(1000);
        expect(await reader.exists(quotaStateRedisKey(s.ws))).toBe(1);

        // A rebuild from an older SQL reading writes nothing over it.
        expect(
          await createRedisQuotaStateCache(reader).fill(
            s.ws,
            { hosted_minutes_month: 'warn', queue_items_month: 'ok' },
            new Date(Date.now() + 3_600_000),
          ),
        ).toBe(false);
        expect(await other.getQuotaState(s.ws)).toEqual({
          hosted_minutes_month: 'reached',
          queue_items_month: 'ok',
        });
        await createRedisQuotaStateCache(writer).drop(s.ws);
      } finally {
        await writer.quit();
        await reader.quit();
        await s.stop();
        await s.t.drop();
      }
    },
    60_000,
  );

  it('finds sweep candidates and pages them by id', async () => {
    const s = await setup(redis);
    try {
      const make = async () => pgWorkspace(s.t.db, s.owner);
      const [active, pending, rolled, idle, old] = [
        s.ws,
        await make(),
        await make(),
        await make(),
        await make(),
      ];
      const now = new Date();
      const counters = createCounterStore(s.db);
      await counters.add([
        {
          workspaceId: active,
          periodStart: new Date(PERIOD.start),
          metric: 'relay.hosted_minutes',
          amount: 5,
        },
        {
          workspaceId: idle,
          periodStart: new Date(PERIOD.start),
          metric: 'agent_minutes',
          amount: 5,
        },
        {
          workspaceId: old,
          periodStart: new Date('2026-01-01T00:00:00.000Z'),
          metric: 'relay.queue_items',
          amount: 5,
        },
      ]);
      await s.db
        .updateTable('usage_counter')
        .set({ updated_at: new Date(now.getTime() - 40 * 86_400_000) })
        .where('workspace_id', '=', old)
        .execute();
      await s.store.decide(pending, (tx) =>
        tx.claim({
          limitKey: 'queue_items_month',
          level: 'warn',
          periodStart: new Date(now.getTime() - 86_400_000),
          periodEnd: new Date(now.getTime() + 86_400_000),
          limitValue: 1000,
        }),
      );
      await s.store.decide(rolled, (tx) =>
        tx.claim({
          limitKey: 'hosted_minutes_month',
          level: 'reached',
          periodStart: new Date(now.getTime() - 30 * 86_400_000),
          periodEnd: new Date(now.getTime() - 60_000),
          limitValue: 6000,
        }),
      );
      await s.store.deliver(rolled, async (tx) => {
        for (const row of await tx.pending()) {
          for (const step of ['notice', 'notification', 'webhook'] as const)
            await tx.mark(row, step, now);
        }
      });
      const expected = [active, pending, rolled].sort();
      expect(await s.store.sweepCandidates(null, 10, now)).toEqual(expected);
      expect(await s.store.sweepCandidates(null, 2, now)).toEqual(expected.slice(0, 2));
      expect(await s.store.sweepCandidates(expected[1] ?? null, 2, now)).toEqual(expected.slice(2));
      // Three hours after the rolled period ended, it is no longer a candidate.
      const later = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      expect(await s.store.sweepCandidates(null, 10, later)).toEqual([active, pending].sort());
    } finally {
      await s.stop();
      await s.t.drop();
    }
  }, 60_000);

  it('goes with its workspace, and refuses unknown limits and levels', async () => {
    const s = await setup(redis);
    try {
      await s.use(6000);
      await s.signals.evaluateQuota(s.ws, NOW);
      expect(await s.rows()).toHaveLength(2);
      for (const bad of [
        sql`insert into quota_signal_state
              (workspace_id, limit_key, period_start, level, period_end, limit_value)
            values (${s.ws}, 'seats', now(), 'warn', now() + interval '1 day', 10)`,
        sql`insert into quota_signal_state
              (workspace_id, limit_key, period_start, level, period_end, limit_value)
            values (${s.ws}, 'queue_items_month', now(), 'ok', now() + interval '1 day', 10)`,
        sql`insert into quota_signal_state
              (workspace_id, limit_key, period_start, level, period_end, limit_value)
            values (${s.ws}, 'queue_items_month', now(), 'warn', now() + interval '1 day', -1)`,
      ]) {
        await expect(bad.execute(s.db)).rejects.toThrow(/check constraint/);
      }
      await sql`delete from workspaces where id = ${s.ws}`.execute(s.db);
      expect(await s.rows()).toHaveLength(0);
    } finally {
      await s.stop();
      await s.t.drop();
    }
  }, 60_000);
});

/**
 * The aggregator (B075 acceptance 1, 5, 6, 7 and 9, guardrails, failure modes): 3 000 events
 * across a month sum exactly, and a second run changes nothing; events from 3 users of one
 * workspace pool into one counter; a late event counts in the period it happened in; at the
 * period boundary the new period starts at 0 and the old one is kept; rows younger than SETTLE_MS
 * wait for a later run; a crash mid-run changes nothing and the next run counts once; the relay's
 * meters are taken into `relay.*` counters, and when the relay is down client metrics still
 * aggregate and the relay's are taken next run; on the real schedule (every 15 s) with a fake
 * clock, usage shows in `QuotaService.compute` within 60 s. Raw rows are never changed. On
 * Postgres 16 (DATABASE_URL): the exact sum, idempotency and a late event in SQL.
 */
import type { UsageAggregationDb } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  SETTLE_MS,
  USAGE_AGGREGATE_EVERY_MS,
  UsageAggregator,
} from '../../../src/modules/usage/aggregate.js';
import { createCounterStore } from '../../../src/modules/usage/counters.js';
import { calendarMonth } from '../../../src/modules/usage/period.js';
import { pgJoin, pgUser, pgWorkspace } from '../../notifications/dispatcher/postgres.js';
import { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
import { usageHarness } from './helpers.js';

const MINUTE = 60_000;

describe('UsageAggregator', () => {
  it('sums 3 000 events exactly, and a second run changes nothing', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const month = calendarMonth(new Date(h.clock.now));
    let expected = 0;
    for (let i = 0; i < 3000; i += 1) {
      const qty = (i % 7) + 1;
      expected += qty;
      h.ingest(
        ws,
        'agent_minutes',
        qty,
        new Date(month.start.getTime() + i * 5 * MINUTE),
        new Date(h.clock.now - 2 * SETTLE_MS),
      );
    }
    const first = await h.aggregator.run();
    expect(first).toEqual({ workspaces: 1, events: 3000 });
    expect(h.counters.counter(ws, month.start, 'agent_minutes')).toBe(expected);
    const second = await h.aggregator.run();
    expect(second.events).toBe(0);
    expect(h.counters.counter(ws, month.start, 'agent_minutes')).toBe(expected);
    expect(h.counters.events).toHaveLength(3000);
  });

  it('pools the events of 3 users of one workspace into one counter', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const at = new Date(h.clock.now - 10 * MINUTE);
    for (let user = 0; user < 3; user += 1)
      h.ingest(ws, 'tokens_in', 100 * (user + 1), at, new Date(h.clock.now - 2 * SETTLE_MS));
    await h.aggregator.run();
    expect(h.counters.counter(ws, calendarMonth(at).start, 'tokens_in')).toBe(600);
  });

  it('counts a late event in the period it happened in, and starts the next period at 0', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const period = {
      start: new Date('2026-09-20T00:00:00Z'),
      end: new Date('2026-10-20T00:00:00Z'),
    };
    await h.subscribe(ws, 'pro', period);
    const received = new Date(h.clock.now - 2 * SETTLE_MS);
    h.ingest(ws, 'agent_minutes', 5, new Date('2026-09-19T23:59:59Z'), received);
    h.ingest(ws, 'agent_minutes', 7, new Date('2026-09-20T00:00:00Z'), received);
    h.ingest(ws, 'agent_minutes', 11, new Date('2026-10-20T00:00:00Z'), received);
    await h.aggregator.run();
    expect(h.counters.counter(ws, new Date('2026-08-20T00:00:00Z'), 'agent_minutes')).toBe(5);
    expect(h.counters.counter(ws, period.start, 'agent_minutes')).toBe(7);
    expect(h.counters.counter(ws, period.end, 'agent_minutes')).toBe(11);
  });

  it('leaves rows younger than SETTLE_MS for a later run, counting each once', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const at = new Date(h.clock.now - MINUTE);
    h.ingest(ws, 'tokens_out', 3, at, new Date(h.clock.now - SETTLE_MS - 1));
    h.ingest(ws, 'tokens_out', 4, at, new Date(h.clock.now - 1000));
    expect((await h.aggregator.run()).events).toBe(1);
    h.clock.advance(SETTLE_MS);
    expect((await h.aggregator.run()).events).toBe(1);
    expect(h.counters.counter(ws, calendarMonth(at).start, 'tokens_out')).toBe(7);
  });

  it('changes nothing when a run crashes, and the next run counts once', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const at = new Date(h.clock.now - MINUTE);
    h.ingest(ws, 'agent_minutes', 9, at, new Date(h.clock.now - 2 * SETTLE_MS));
    h.counters.crash = new Error('connection lost');
    await expect(h.aggregator.run()).rejects.toThrow('connection lost');
    expect(h.counters.counters.size).toBe(0);
    expect(h.counters.highWater.getTime()).toBe(0);
    h.counters.crash = undefined;
    await h.aggregator.run();
    await h.aggregator.run();
    expect(h.counters.counter(ws, calendarMonth(at).start, 'agent_minutes')).toBe(9);
  });

  it("takes the relay's meters, and still aggregates client metrics while the relay is down", async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const month = calendarMonth(new Date(h.clock.now));
    h.relay.record(ws, 'hosted_minutes', 42);
    h.relay.record(ws, 'queue_items', 5);
    h.relay.down = true;
    h.ingest(
      ws,
      'agent_minutes',
      3,
      new Date(h.clock.now - MINUTE),
      new Date(h.clock.now - 2 * SETTLE_MS),
    );
    await h.aggregator.run();
    expect(h.counters.counter(ws, month.start, 'agent_minutes')).toBe(3);
    expect(h.counters.counter(ws, month.start, 'relay.hosted_minutes')).toBe(0);
    h.relay.down = false;
    await h.aggregator.run();
    expect(h.counters.counter(ws, month.start, 'relay.hosted_minutes')).toBe(42);
    expect(h.counters.counter(ws, month.start, 'relay.queue_items')).toBe(5);
    await h.aggregator.run();
    expect(h.counters.counter(ws, month.start, 'relay.hosted_minutes')).toBe(42);
  });

  it('shows usage in QuotaService.compute within 60 s on the real schedule', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    await h.subscribe(ws, 'pro', calendarMonth(new Date(h.clock.now)));
    const t = h.clock.now;
    h.relay.record(ws, 'hosted_minutes', 30);
    h.ingest(ws, 'agent_minutes', 1, new Date(t), new Date(t));
    let seenAt: number | null = null;
    for (let tick = 1; tick <= 4 && seenAt === null; tick += 1) {
      h.clock.advance(USAGE_AGGREGATE_EVERY_MS);
      await h.aggregator.run();
      const state = await h.quota.compute(ws);
      const hosted = state.items.find((i) => i.key === 'hosted_minutes_month');
      const agent = h.counters.counter(ws, state.period.start, 'agent_minutes');
      if (hosted?.used === 30 && agent === 1) seenAt = h.clock.now;
    }
    expect(seenAt).not.toBeNull();
    expect((seenAt ?? Infinity) - t).toBeLessThanOrEqual(60_000);
  });
});

describe.runIf(ADMIN_URL !== undefined)('aggregation on Postgres 16', () => {
  it('sums 3 000 rows exactly, idempotently, with a late event in its own period', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<UsageAggregationDb>;
      const user = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, user);
      await pgJoin(t.db, ws, user, 'owner');
      const now = new Date();
      const month = calendarMonth(now);
      const received = new Date(now.getTime() - 2 * SETTLE_MS);
      // 3 000 rows at one-minute steps from the month's start (within the month), qty 1..7.
      await sql`
        insert into usage_event (workspace_id, event_id, type, qty, at, device_id, received_at)
        select ${ws}, 'use_' || lpad(g::text, 26, '0'), 'agent_minutes', (g % 7) + 1,
          ${month.start}::timestamptz + make_interval(mins => g), 'dev_' || lpad('1', 26, '0'),
          ${received}::timestamptz
        from generate_series(1, 3000) as g
      `.execute(db);
      await sql`
        insert into usage_event (workspace_id, event_id, type, qty, at, device_id, received_at)
        values (${ws}, ${'use_' + '9'.repeat(26)}, 'agent_minutes', 13,
          ${new Date(month.start.getTime() - 1000)}, ${'dev_' + '1'.padStart(26, '0')}, ${received})
      `.execute(db);
      const counters = createCounterStore(db);
      const aggregator = new UsageAggregator({
        counters,
        periods: { period: () => Promise.resolve(null) },
        clock: () => now.getTime(),
      });
      expect(await aggregator.run()).toEqual({ workspaces: 1, events: 3001 });
      expect(await aggregator.run()).toEqual({ workspaces: 0, events: 0 });
      let expected = 0;
      for (let g = 1; g <= 3000; g += 1) expected += (g % 7) + 1;
      expect((await counters.totals(ws, month.start)).agent_minutes).toBe(expected);
      const previous = calendarMonth(new Date(month.start.getTime() - 1000));
      expect((await counters.totals(ws, previous.start)).agent_minutes).toBe(13);
      const raw = await db
        .selectFrom('usage_event')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(raw.n)).toBe(3001);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('rolls a crossing claim back when its bump fails, and claims each once', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<UsageAggregationDb>;
      const user = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, user);
      const counters = createCounterStore(db);
      const period = new Date('2026-10-01T00:00:00Z');
      const at = new Date('2026-10-08T12:00:00Z');
      await expect(
        counters.claimCrossing(ws, period, 'hosted_minutes_month', 80, at, () =>
          Promise.reject(new Error('bump failed')),
        ),
      ).rejects.toThrow('bump failed');
      expect((await counters.crossings(ws, period)).every((c) => c.crossed80At === null)).toBe(
        true,
      );
      let bumps = 0;
      const bump = () => {
        bumps += 1;
        return Promise.resolve();
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          counters.claimCrossing(ws, period, 'hosted_minutes_month', 80, at, bump),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(bumps).toBe(1);
      expect(await counters.crossings(ws, period)).toEqual([
        { limitKey: 'hosted_minutes_month', crossed80At: at, crossed100At: null },
      ]);
    } finally {
      await t.drop();
    }
  }, 60_000);
});

/**
 * Ingestion (B074 acceptance 2, 3 and 8, guardrails, failure modes): 500 valid events answer
 * `{accepted:500, duplicates:0}`; re-sending 100 of them under a new Idempotency-Key answers
 * `{accepted:0, duplicates:100}` and stores nothing more; two concurrent requests carrying the
 * same ids store each once and both answer 200; dedupe is per workspace; only the contract
 * fields, the device and the receive time are stored. The daily cap refuses past its limit (429
 * until midnight UTC) and never blocks when Redis fails; a plan quota is not checked at all. A
 * hint goes out on `usage:ingested`, and its failure does not fail the batch. A database timeout
 * is 503 with `retry_after_s`. On Postgres 16 (DATABASE_URL): 500 events within 500 ms, dedupe
 * and concurrency in SQL.
 */
import type { UsageDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { USAGE_HINT_CHANNEL, UsageIngest } from '../../../src/modules/usage/ingest.js';
import { createUsageRepository } from '../../../src/modules/usage/repository.js';
import { parseUsageBatch } from '../../../src/modules/usage/validate.js';
import { pgJoin, pgUser, pgWorkspace } from '../../notifications/dispatcher/postgres.js';
import { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
import { memoryUsage, newId, T0, usageApp, usageEvents } from './helpers.js';

const post = (
  ctx: Awaited<ReturnType<typeof usageApp>>,
  headers: Record<string, string>,
  events: unknown[],
) => ctx.app.inject({ method: 'POST', url: '/v1/usage/events', headers, payload: { events } });

describe('POST /v1/usage/events', () => {
  it('stores 500 events, then counts 100 re-sent ones as duplicates', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    const workspace = ctx.memory.personal(d.userId);
    const events = usageEvents(500);
    const first = await post(ctx, d.headers(), events);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 500, duplicates: 0 });
    expect(ctx.memory.rows.size).toBe(500);
    const again = await post(ctx, d.headers(), events.slice(0, 100));
    expect(again.json()).toEqual({ accepted: 0, duplicates: 100 });
    expect(ctx.memory.rows.size).toBe(500);
    const row = [...ctx.memory.rows.values()][0];
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'agentId',
        'at',
        'deviceId',
        'eventId',
        'qty',
        'receivedAt',
        'sessionId',
        'type',
        'workspaceId',
      ].sort(),
    );
    expect(row).toMatchObject({
      workspaceId: workspace,
      deviceId: d.deviceId,
      receivedAt: new Date(T0),
    });
    await ctx.app.close();
  });

  it('stores each id once for two concurrent requests with the same ids, both 200', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const events = usageEvents(50);
    const [a, b] = await Promise.all([
      post(ctx, d.headers(), events),
      post(ctx, d.headers(), events),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const results = [a.json<{ accepted: number }>(), b.json<{ accepted: number }>()];
    expect(results.map((r) => r.accepted).sort((x, y) => x - y)).toEqual([0, 50]);
    expect(ctx.memory.rows.size).toBe(50);
    await ctx.app.close();
  });

  it('dedupes per workspace: the same id in two workspaces is two events', async () => {
    const memory = memoryUsage();
    const ingest = new UsageIngest({ repository: memory.repository, clock: () => T0 });
    const events = parseUsageBatch({ events: usageEvents(3) }, new Date(T0));
    const alice = { userId: newId('usr'), deviceId: newId('dev') };
    const bob = { userId: newId('usr'), deviceId: newId('dev') };
    memory.personal(alice.userId);
    memory.personal(bob.userId);
    expect(await ingest.ingest(alice, events)).toEqual({ accepted: 3, duplicates: 0 });
    expect(await ingest.ingest(bob, events)).toEqual({ accepted: 3, duplicates: 0 });
    expect(memory.rows.size).toBe(6);
  });

  it('sends a hint for B075, and a failed hint does not fail the batch', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    const workspace = ctx.memory.personal(d.userId);
    await post(ctx, d.headers(), usageEvents(2));
    expect(ctx.published).toEqual([
      {
        channel: USAGE_HINT_CHANNEL,
        message: JSON.stringify({
          workspaces: [workspace],
          received_at: new Date(T0).toISOString(),
        }),
      },
    ]);
    const failing = await usageApp(memoryUsage(), {
      deps: { pubsub: { publish: () => Promise.reject(new Error('redis down')) } },
    });
    const d2 = await failing.device();
    failing.memory.personal(d2.userId);
    const response = await post(failing, d2.headers(), usageEvents(2));
    expect(response.statusCode).toBe(200);
    expect(failing.captured.lines().some((l) => l['msg'] === 'usage.hint_failed')).toBe(true);
    await ctx.app.close();
    await failing.app.close();
  });

  it('refuses past the daily cap until midnight UTC, and never blocks when Redis fails', async () => {
    const ctx = await usageApp(memoryUsage(), { deps: { dailyEventCap: 5 } });
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    expect((await post(ctx, d.headers(), usageEvents(4))).json()).toEqual({
      accepted: 4,
      duplicates: 0,
    });
    const over = await post(ctx, d.headers(), usageEvents(2));
    expect(over.statusCode).toBe(429);
    const body = over.json<{ code: string; retry_after_s: number }>();
    expect(body.code).toBe('rate_limited');
    // T0 is 12:00 UTC: twelve hours to midnight.
    expect(body.retry_after_s).toBe(12 * 60 * 60);
    expect(ctx.memory.rows.size).toBe(4);

    const broken = await usageApp(memoryUsage(), {
      deps: {
        dailyEventCap: 1,
        kv: {
          get: () => Promise.reject(new Error('redis down')),
          set: () => Promise.reject(new Error('redis down')),
          setIfAbsent: () => Promise.reject(new Error('redis down')),
          del: () => Promise.reject(new Error('redis down')),
          incr: () => Promise.reject(new Error('redis down')),
          ttl: () => Promise.reject(new Error('redis down')),
        },
      },
    });
    const d2 = await broken.device();
    broken.memory.personal(d2.userId);
    expect((await post(broken, d2.headers(), usageEvents(3))).json()).toEqual({
      accepted: 3,
      duplicates: 0,
    });
    await ctx.app.close();
    await broken.app.close();
  });

  it('answers 503 with retry_after_s when the database times out', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    ctx.memory.failWith(() => Object.assign(new Error('canceling statement'), { code: '57014' }));
    const response = await post(ctx, d.headers(), usageEvents(3));
    expect(response.statusCode).toBe(503);
    expect(response.json<{ retry_after_s: number }>().retry_after_s).toBeGreaterThan(0);
    await ctx.app.close();
  });
});

describe.runIf(ADMIN_URL !== undefined)('ingestion on Postgres 16', () => {
  it('stores 500 events within 500 ms, dedupes re-sent and concurrent ids', async () => {
    const t = await migratedDatabase(10);
    try {
      const db = t.db as unknown as Kysely<UsageDb>;
      const user = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, user);
      await pgJoin(t.db, ws, user, 'owner');
      const ingest = new UsageIngest({
        repository: createUsageRepository(db),
        clock: () => Date.now(),
      });
      const principal = { userId: user, deviceId: newId('dev'), workspaceId: ws };
      const batch = () =>
        parseUsageBatch(
          { events: usageEvents(500, { at: new Date(Date.now() - 60_000).toISOString() }) },
          new Date(),
        );

      // Warm the connection and plan, then time a fresh batch.
      await ingest.ingest(principal, batch());
      const events = batch();
      const start = performance.now();
      expect(await ingest.ingest(principal, events)).toEqual({ accepted: 500, duplicates: 0 });
      expect(performance.now() - start).toBeLessThan(500);

      expect(await ingest.ingest(principal, events.slice(0, 100))).toEqual({
        accepted: 0,
        duplicates: 100,
      });
      const concurrent = batch();
      const both = await Promise.all([
        ingest.ingest(principal, concurrent),
        ingest.ingest(principal, concurrent),
      ]);
      expect(both.map((r) => r.accepted).reduce((a, b) => a + b)).toBe(500);
      const count = await db
        .selectFrom('usage_event')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(1500);
      const row = await db.selectFrom('usage_event').selectAll().limit(1).executeTakeFirstOrThrow();
      expect(Object.keys(row).sort()).toEqual(
        [
          'agent_id',
          'at',
          'device_id',
          'event_id',
          'qty',
          'received_at',
          'session_id',
          'type',
          'workspace_id',
        ].sort(),
      );
      expect(row.workspace_id).toBe(ws);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('answers a 500-event batch over HTTP with 200 within 500 ms', async () => {
    const t = await migratedDatabase(10);
    try {
      const repository = createUsageRepository(t.db as unknown as Kysely<UsageDb>);
      // The app's clock (T0) checks `at` and stamps received_at; events are a minute before it.
      const ctx = await usageApp(memoryUsage(), { deps: { repository } });
      const d = await ctx.device();
      // The device's user, with a personal workspace, in the database.
      await t.db
        .insertInto('users')
        .values({
          id: d.userId,
          email: `${d.userId.toLowerCase()}@example.test`,
          display_name: 'Usage',
        })
        .execute();
      const ws = await pgWorkspace(t.db, d.userId);
      await pgJoin(t.db, ws, d.userId, 'owner');
      const fresh = () => usageEvents(500);
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: d.headers(),
        payload: { events: fresh() },
      });
      const start = performance.now();
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: d.headers(),
        payload: { events: fresh() },
      });
      const elapsed = performance.now() - start;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: 500, duplicates: 0 });
      expect(elapsed).toBeLessThan(500);
      await ctx.app.close();
    } finally {
      await t.drop();
    }
  }, 60_000);
});

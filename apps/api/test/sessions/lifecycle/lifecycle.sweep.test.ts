/**
 * The sweep (B053; tests "lifecycle.sweep.test.ts", acceptance 3 and the failure modes): paused
 * 24 h minus 1 s stays paused, 24 h expires; a second sweep changes nothing; concurrent sweepers
 * (the advisory lock) transition each session once; the relay unreachable: the transition stays
 * committed and the notification is retried from the outbox with backoff; the worker job runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HOST_GRACE_MS,
  PAUSED_EXPIRY_MS,
  OUTBOX_BASE_DELAY_MS,
  type SessionsDb,
} from '../../../src/modules/sessions/index.js';
import { processSessionExpiry } from '../../../../worker/src/jobs/session-expiry.js';
import type { TestDatabase } from '../../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase, T0 } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('the sweep on Postgres 16', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await migratedDatabase(10);
  });
  afterAll(async () => {
    await test?.drop();
  });

  /** `n` sessions whose host left at `left`, swept to paused at `left` + 10 min. */
  async function paused(n: number, base: number) {
    const env = lifecycleOn(test.db);
    env.entitlements.state.limits['max_concurrent_sessions'] = null;
    env.clock.now = base;
    const w = await env.seed();
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const s = await env.service.create({
        workspaceId: w.workspace,
        creatorUserId: w.owner.user,
        creatorDeviceId: w.owner.device,
        name: `S${i}`,
        region: 'eu',
      });
      ids.push(s.id);
    }
    const pausedAt = new Date(base + HOST_GRACE_MS);
    await env.service.sweep(pausedAt);
    for (const id of ids) expect(await env.stateOf(id)).toBe('paused');
    return { env, ids, pausedAt: pausedAt.getTime() };
  }

  it('24 h minus 1 s: still paused; 24 h: expired; a second sweep changes nothing', async () => {
    const { env, ids, pausedAt } = await paused(2, T0 + 100 * 86_400_000);
    await env.service.sweep(new Date(pausedAt + PAUSED_EXPIRY_MS - 1_000));
    for (const id of ids) expect(await env.stateOf(id)).toBe('paused');
    const first = await env.service.sweep(new Date(pausedAt + PAUSED_EXPIRY_MS));
    expect(first.expired).toBeGreaterThanOrEqual(2);
    const rows = await test.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', 'in', ids)
      .orderBy('id')
      .execute();
    for (const r of rows) expect(r).toMatchObject({ state: 'expired', end_reason: 'expired' });
    const second = await env.service.sweep(new Date(pausedAt + PAUSED_EXPIRY_MS));
    expect(second).toEqual({ paused: 0, expired: 0 });
    expect(
      await test.db
        .selectFrom('sessions')
        .selectAll()
        .where('id', 'in', ids)
        .orderBy('id')
        .execute(),
    ).toEqual(rows);
    expect(
      env.events.filter((e) => e.type === 'session.ended' && ids.includes(e.data.session)),
    ).toHaveLength(2);
  });

  it('concurrent sweepers transition each session exactly once', async () => {
    const { env, ids, pausedAt } = await paused(20, T0 + 200 * 86_400_000);
    const now = new Date(pausedAt + PAUSED_EXPIRY_MS);
    const results = await Promise.all(Array.from({ length: 4 }, () => env.service.sweep(now)));
    const expired = results.reduce((n, r) => n + r.expired, 0);
    expect(expired).toBeGreaterThanOrEqual(20);
    const outbox = await (test.db as unknown as SessionsDb)
      .selectFrom('session_outbox')
      .select(['session_id'])
      .where('session_id', 'in', ids)
      .where('state', '=', 'expired')
      .execute();
    expect(outbox).toHaveLength(20);
    expect(new Set(outbox.map((o) => o.session_id)).size).toBe(20);
  });

  it('the relay unreachable: the transition is committed, then retried with backoff', async () => {
    const { env, ids, pausedAt } = await paused(1, T0 + 300 * 86_400_000);
    const [id] = ids as [string];
    env.failing.relay = true;
    env.relayed.length = 0;
    const now = pausedAt + PAUSED_EXPIRY_MS;
    await env.service.sweep(new Date(now));
    expect(await env.stateOf(id)).toBe('expired');
    expect(env.relayed).toEqual([]);
    env.failing.relay = false;
    // Not before the backoff.
    await env.service.deliverOutbox(now + OUTBOX_BASE_DELAY_MS - 1, id);
    expect(env.relayed).toEqual([]);
    await env.service.deliverOutbox(now + OUTBOX_BASE_DELAY_MS, id);
    expect(env.relayed).toEqual([{ sid: id, state: 'expired' }]);
    // The event went out on the first try; it is not sent twice.
    expect(
      env.events.filter((e) => e.data.session === id && e.type === 'session.ended'),
    ).toHaveLength(1);
  });

  it('the worker job runs the sweep and reports its counts', async () => {
    const { env, pausedAt } = await paused(1, T0 + 400 * 86_400_000);
    const result = await processSessionExpiry({
      sessions: env.service,
      clock: () => pausedAt + PAUSED_EXPIRY_MS,
    });
    expect(result.expired).toBeGreaterThanOrEqual(1);
  });
});

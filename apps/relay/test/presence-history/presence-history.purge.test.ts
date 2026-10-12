/**
 * B067 retention on Postgres 16 (acceptance 4; guardrail: 30-day retention): `purgeOlderThan(30
 * days ago)` deletes only `presence_log` rows older than the cutoff (also across several batches),
 * returns the exact count, and leaves `member_last_seen` untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HistoryEvent } from '../../src/presence-history/ports.js';
import { purgeOlderThan, retentionCutoff } from '../../src/presence-history/purge.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

describe.runIf(STACK)('presence log retention on Postgres 16 (acceptance 4)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('deletes only rows older than the cutoff, exactly, and no last-seen row', async () => {
    const env = await pgEnv(stack);
    const s = await env.session();
    const m = await env.member(s.id);
    const day = 86_400_000;
    const cutoff = retentionCutoff(env.clock.now);
    expect(cutoff.getTime()).toBe(env.clock.now - 30 * day);
    const at = (msBeforeCutoff: number) => new Date(cutoff.getTime() - msBeforeCutoff);
    const events: HistoryEvent[] = [];
    // 7 rows older than the cutoff, 1 exactly at it and 2 newer (kept).
    for (let i = 1; i <= 7; i++) {
      events.push({
        kind: i % 2 === 1 ? 'connected' : 'disconnected',
        sid: s.id,
        memberId: m.id,
        deviceId: m.device,
        at: at(i * day),
        ...(i % 2 === 1 ? {} : { reason: 'closed' as const }),
      } as HistoryEvent);
    }
    events.sort((x, y) => x.at.getTime() - y.at.getTime());
    events.push(
      { kind: 'connected', sid: s.id, memberId: m.id, deviceId: m.device, at: cutoff },
      {
        kind: 'disconnected',
        sid: s.id,
        memberId: m.id,
        deviceId: m.device,
        at: at(-day),
        reason: 'timeout',
      },
      { kind: 'connected', sid: s.id, memberId: m.id, deviceId: m.device, at: at(-2 * day) },
    );
    await env.writer.write(events);
    const lastSeenBefore = await env.db.selectFrom('member_last_seen').selectAll().execute();
    // In batches of 3: 3 + 3 + 1, counted exactly.
    expect(await purgeOlderThan(env.db, cutoff, 3)).toBe(7);
    expect(await env.history.purgeOlderThan(cutoff)).toBe(0);
    await expect(purgeOlderThan(env.db, cutoff, 0)).rejects.toThrow(RangeError);
    const left = await env.db
      .selectFrom('presence_log')
      .select(['at'])
      .where('session_id', '=', s.id)
      .execute();
    expect(left).toHaveLength(3);
    expect(left.every((r) => r.at.getTime() >= cutoff.getTime())).toBe(true);
    expect(await env.db.selectFrom('member_last_seen').selectAll().execute()).toEqual(
      lastSeenBefore,
    );
  });
});

/**
 * B067 lookups on Postgres 16 (acceptance 2, 6; failure mode: out-of-order events):
 *
 * - `lastSeen`: null for a member who never connected; the start of the current minute while
 *   connected; the time its latest connection closed once offline; a connected row three minutes
 *   stale no longer counts as online; an older event written after a newer one moves nothing back.
 * - `recentSessions`: the device's sessions, newest first, at most `limit` (<= 50); a session the
 *   device's member was kicked from is left out, while that member's `lastSeen` stays queryable.
 * - The log keeps one row per online/offline event; touches only move last-seen.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

describe.runIf(STACK)('presence history lookups on Postgres 16 (acceptance 2, 6)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('lastSeen: never, connected now, then the disconnect time', async () => {
    const env = await pgEnv(stack);
    const s = await env.session();
    const m = await env.member(s.id);
    expect(await env.history.lastSeen(s.id, m.id)).toBeNull();
    const t0 = new Date(env.clock.now - 120_000);
    await env.writer.write([
      { kind: 'connected', sid: s.id, memberId: m.id, deviceId: m.device, at: t0 },
      {
        kind: 'touch',
        sid: s.id,
        memberId: m.id,
        deviceId: m.device,
        at: new Date(env.clock.now - 30_000),
      },
    ]);
    // Connected: the start of the current minute.
    expect(await env.history.lastSeen(s.id, m.id)).toEqual(new Date('2026-10-11T12:00:00.000Z'));
    const closed = new Date(env.clock.now - 10_000);
    await env.writer.write([
      {
        kind: 'disconnected',
        sid: s.id,
        memberId: m.id,
        deviceId: m.device,
        at: closed,
        reason: 'closed',
      },
    ]);
    expect(await env.history.lastSeen(s.id, m.id)).toEqual(closed);
    // An older event arriving late moves nothing back.
    await env.writer.write([
      {
        kind: 'touch',
        sid: s.id,
        memberId: m.id,
        deviceId: m.device,
        at: new Date(env.clock.now - 60_000),
      },
    ]);
    expect(await env.history.lastSeen(s.id, m.id)).toEqual(closed);
    const log = await env.db
      .selectFrom('presence_log')
      .select(['event', 'reason'])
      .where('session_id', '=', s.id)
      .orderBy('at')
      .execute();
    expect(log).toEqual([
      { event: 'connected', reason: null },
      { event: 'disconnected', reason: 'closed' },
    ]);
  });

  it('skips events of a deleted session; the rest of the batch is written', async () => {
    const env = await pgEnv(stack);
    const [s1, s2] = [await env.session(), await env.session()];
    const [m1, m2] = [await env.member(s1.id), await env.member(s2.id)];
    await env.db.deleteFrom('session_members').where('session_id', '=', s2.id).execute();
    await env.db.deleteFrom('sessions').where('id', '=', s2.id).execute();
    const at = new Date(env.clock.now - 1_000);
    await env.writer.write([
      { kind: 'connected', sid: s2.id, memberId: m2.id, deviceId: m2.device, at },
      { kind: 'connected', sid: s1.id, memberId: m1.id, deviceId: m1.device, at },
    ]);
    expect(await env.history.lastSeen(s1.id, m1.id)).not.toBeNull();
    expect(await env.history.lastSeen(s2.id, m2.id)).toBeNull();
  });

  it('on a tie, a disconnect beats a touch in one batch', async () => {
    const env = await pgEnv(stack);
    const s = await env.session();
    const m = await env.member(s.id);
    const at = new Date(env.clock.now - 10_000);
    await env.writer.write([
      { kind: 'disconnected', sid: s.id, memberId: m.id, deviceId: m.device, at, reason: 'kicked' },
      { kind: 'touch', sid: s.id, memberId: m.id, deviceId: m.device, at },
    ]);
    expect(await env.history.lastSeen(s.id, m.id)).toEqual(at);
  });

  it('a connected row three minutes stale no longer counts as online', async () => {
    const env = await pgEnv(stack);
    const s = await env.session();
    const m = await env.member(s.id);
    const at = new Date(env.clock.now - 180_000);
    await env.writer.write([
      { kind: 'connected', sid: s.id, memberId: m.id, deviceId: m.device, at },
    ]);
    expect(await env.history.lastSeen(s.id, m.id)).toEqual(at);
  });

  it('recentSessions: newest first, at most the limit, not sessions the device was kicked from', async () => {
    const env = await pgEnv(stack);
    const [s1, s2, s3] = [await env.session(), await env.session(), await env.session()];
    const device = (await env.member(s1.id)).device;
    // The same user and device in three sessions.
    const user = await env.db
      .selectFrom('session_members')
      .select(['user_id'])
      .where('session_id', '=', s1.id)
      .executeTakeFirstOrThrow();
    const f = (await import('@centcom/testkit')).createFactories(stack.db);
    const ids: Record<string, string> = {};
    const m1 = await env.db
      .selectFrom('session_members')
      .select(['id'])
      .where('session_id', '=', s1.id)
      .executeTakeFirstOrThrow();
    ids[s1.id] = m1.id;
    for (const s of [s2, s3]) {
      const m = await f.sessionMembers.create({
        session: s.id,
        user: user.user_id,
        device,
        role: 'editor',
      });
      ids[s.id] = m.id;
    }
    let minutes = 10;
    for (const s of [s1, s2, s3]) {
      await env.writer.write([
        {
          kind: 'disconnected',
          sid: s.id,
          memberId: ids[s.id] ?? '',
          deviceId: device,
          at: new Date(env.clock.now - minutes-- * 60_000),
          reason: 'closed',
        },
      ]);
    }
    // disconnected without a connected first is fine for the row (the log keeps it).
    expect((await env.history.recentSessions(device, 50)).map((r) => r.sid)).toEqual([
      s3.id,
      s2.id,
      s1.id,
    ]);
    expect(await env.history.recentSessions(device, 2)).toHaveLength(2);
    expect(await env.history.recentSessions(device, 500)).toHaveLength(3);
    expect(await env.history.recentSessions(newId('dev'), 10)).toEqual([]);
    // Kicked from s2: left out of the device's sessions, still queryable for audit.
    await env.db
      .updateTable('session_members')
      .set({ left_at: new Date() })
      .where('id', '=', ids[s2.id] ?? '')
      .execute();
    expect((await env.history.recentSessions(device, 50)).map((r) => r.sid)).toEqual([
      s3.id,
      s1.id,
    ]);
    expect(await env.history.lastSeen(s2.id, ids[s2.id] ?? '')).toEqual(
      new Date(env.clock.now - 9 * 60_000),
    );
  });
});

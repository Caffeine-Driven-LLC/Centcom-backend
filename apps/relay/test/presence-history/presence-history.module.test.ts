/**
 * B067 wiring on Postgres 16: `presence-history/module.ts` registers its stage at 35 and sets
 * `ctx.presenceHistory`; a member's join writes it online; a frame through the stage touches it; a
 * kick (close 4403) followed by the grace writes it offline with reason `kicked`, at the close
 * time; a second connection's leave writes nothing; the shutdown step flushes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import { createPresenceHistoryModule } from '../../src/presence-history/module.js';
import type { MemberView } from '../../src/rooms/registry.js';
import { roomsFor } from '../../src/rooms/runtime.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { fakeConnection } from '../rooms/helpers.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(STACK)('presence-history/module.ts on Postgres 16', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('records online, touches and a kick through the rooms and the stage', async () => {
    const env = await pgEnv(stack);
    const s = await env.session();
    const m = await env.member(s.id);
    const clock = { now: Date.now() };
    const pipeline = new FramePipeline();
    const shutdown: (() => Promise<void>)[] = [];
    const ctx = {
      log: captureLogger().logger,
      metrics: recordingMetrics().metrics,
      clock: () => clock.now,
      db: stack.db,
      redis: {},
      pipeline,
      onConnection: () => undefined,
      onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
    } as unknown as RelayContext;
    // A short grace so the test does not wait 10 s.
    await createPresenceHistoryModule({ RELAY_OFFLINE_GRACE_MS: '200' }).register(ctx);
    expect(pipeline.orders()).toEqual([STAGE_ORDER.presence]);
    expect(ctx.presenceHistory).toBeDefined();

    const member: MemberView = {
      id: m.id,
      sid: s.id,
      role: 'editor',
      userId: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      workspaceId: null,
      name: 'Alex',
      slot: 0,
    };
    const room = roomsFor(ctx).registry.getOrCreate(s.id);
    const [a, b] = [fakeConnection(s.id), fakeConnection(s.id)];
    a.entry.deviceId = m.device;
    b.entry.deviceId = m.device;
    room.join(a, member);
    room.join(b, member);
    // A frame a minute later touches the member through the stage.
    clock.now += 61_000;
    const touchedAt = clock.now;
    await pipeline.run({ connection: a, raw: null, frame: { v: 1, t: 'ping' }, state: {} });
    // b leaves: a is still here, nothing written.
    room.leave(b);
    await vi.waitFor(
      async () => {
        const row = await env.db
          .selectFrom('member_last_seen')
          .select(['last_seen_at'])
          .where('session_id', '=', s.id)
          .executeTakeFirst();
        expect(row?.last_seen_at.getTime()).toBe(touchedAt);
      },
      { timeout: 10_000, interval: 100 },
    );
    // a is kicked: 4403, then the grace (200 ms here).
    clock.now += 1_000;
    const closedAt = clock.now;
    room.closeMember(m.id, 4403);
    await wait(400);
    await shutdown[0]?.();
    const log = await env.db
      .selectFrom('presence_log')
      .select(['event', 'reason', 'at'])
      .where('session_id', '=', s.id)
      .orderBy('id')
      .execute();
    expect(log.map((r) => [r.event, r.reason])).toEqual([
      ['connected', null],
      ['disconnected', 'kicked'],
    ]);
    expect(log[1]?.at.getTime()).toBe(closedAt);
    expect(await ctx.presenceHistory?.lastSeen(s.id, m.id)).toEqual(log[1]?.at);
  }, 30_000);
});

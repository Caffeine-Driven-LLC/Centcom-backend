/**
 * B060 wiring: `approvals/module.ts` registers the approvals stage at 39 (before sequencing),
 * exports `relay_approvals_pending` through the relay's metric guard, sweeps every second (a
 * session a member joined on this node), sequences the timeout deny through B044's `emitServer`
 * as `approval.decision {decision:'deny', scope:'once'}` from the server, and stops on shutdown.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import relayModule, { APPROVAL_SWEEP_MS } from '../../src/approvals/module.js';
import { createRedisApprovalStore } from '../../src/approvals/store.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import { guardMetrics } from '../../src/privacy/metrics.js';
import type { MemberView } from '../../src/rooms/registry.js';
import { roomsFor } from '../../src/rooms/runtime.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { fakeConnection } from '../rooms/helpers.js';

describe('approvals/module.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers at 39, exports the gauge, sweeps a joined session and emits the deny', async () => {
    expect(relayModule).toMatchObject({ name: 'approvals', order: 39 });
    expect(STAGE_ORDER.control).toBeLessThan(39);
    expect(39).toBeLessThan(STAGE_ORDER.sequence);
    const pipeline = new FramePipeline();
    const gauges = new Map<string, () => unknown>();
    const shutdown: (() => Promise<void>)[] = [];
    const emitted: { sid: string; kind: string; t: string; p: Record<string, unknown> }[] = [];
    const redis = createMemoryRedis();
    // The module's clock (expiry decisions); Redis keeps real time, and the keys outlive the test.
    const clock = { now: Date.now() };
    const ctx = {
      log: captureLogger().logger,
      metrics: guardMetrics({
        ...recordingMetrics().metrics,
        gauge: (name: string, read: () => unknown) => void gauges.set(name, read),
      } as never),
      clock: () => clock.now,
      db: {},
      redis,
      pipeline,
      fanout: {
        emitServer(sid: string, kind: string, t: string, p: Record<string, unknown>) {
          emitted.push({ sid, kind, t, p });
          return Promise.resolve({ seq: 1 });
        },
      },
      onConnection: () => undefined,
      onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
    } as unknown as RelayContext;
    await relayModule.register(ctx);
    expect(pipeline.orders()).toEqual([39]);
    expect(await gauges.get('relay_approvals_pending')?.()).toBe(0);

    // A pending approval written by any node, expiring in 3 s.
    const sid = newId('ses');
    const approvalId = newId('apr');
    await createRedisApprovalStore({ kv: redis.kv }).create(
      sid,
      {
        approvalId,
        agentId: newId('agt'),
        requester: newId('mem'),
        risk: 'low',
        approver: 'host',
        expiresAt: new Date(clock.now + 3_000).toISOString(),
        requestedAt: clock.now,
        requestSeq: 7,
        frameId: newId('msg'),
      },
      63_000,
    );
    const member: MemberView = {
      id: newId('mem'),
      sid,
      role: 'editor',
      userId: newId('usr'),
      workspaceId: newId('wsp'),
      name: 'Alex',
      slot: 0,
    };
    roomsFor(ctx).registry.getOrCreate(sid).join(fakeConnection(sid), member);
    await vi.advanceTimersByTimeAsync(APPROVAL_SWEEP_MS);
    expect(await gauges.get('relay_approvals_pending')?.()).toBe(1);
    expect(emitted).toEqual([]);
    clock.now += 3_000;
    await vi.advanceTimersByTimeAsync(APPROVAL_SWEEP_MS);
    expect(emitted).toEqual([
      {
        sid,
        kind: 'approval.decision',
        t: 'event',
        p: { approval_id: approvalId, decision: 'deny', scope: 'once' },
      },
    ]);
    expect(shutdown).toHaveLength(1);
    await shutdown[0]?.();
  });
});

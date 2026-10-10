/**
 * Host loss (B053; tests "lifecycle.host-loss.test.ts", acceptance 2, 4 and 7): the 10 min grace
 * on a fake clock (599 s live, 600 s paused, one relay notification), the host coming back (one
 * `live` notification), and the failover candidate (the longest-connected editor after 120 s when
 * the policy allows it; none otherwise, and the session pauses at the grace).
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateHostLoss,
  FAILOVER_AFTER_MS,
  HOST_GRACE_MS,
} from '../../../src/modules/sessions/index.js';
import type { TestDatabase } from '../../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase, T0 } from './helpers.js';

describe('the evaluator', () => {
  const editors = [
    { memberId: newId('mem'), connectedSince: T0 - 5_000 },
    { memberId: newId('mem'), connectedSince: T0 - 60_000 },
    { memberId: newId('mem'), connectedSince: T0 - 1_000 },
  ];

  it('picks the longest-connected editor after 120 s with auto_failover', () => {
    expect(
      evaluateHostLoss({
        hostAbsentSince: T0,
        now: T0 + FAILOVER_AFTER_MS - 1,
        autoFailover: true,
        editors,
      }),
    ).toEqual({ failover: null, pause: false });
    expect(
      evaluateHostLoss({
        hostAbsentSince: T0,
        now: T0 + FAILOVER_AFTER_MS,
        autoFailover: true,
        editors,
      }),
    ).toEqual({ failover: editors[1]?.memberId, pause: false });
  });

  it('none without editors or with the flag off; then the session pauses at the grace', () => {
    for (const input of [
      { autoFailover: true, editors: [] },
      { autoFailover: false, editors },
    ]) {
      expect(
        evaluateHostLoss({ hostAbsentSince: T0, now: T0 + FAILOVER_AFTER_MS, ...input }),
      ).toEqual({
        failover: null,
        pause: false,
      });
      expect(evaluateHostLoss({ hostAbsentSince: T0, now: T0 + HOST_GRACE_MS, ...input })).toEqual({
        failover: null,
        pause: true,
      });
    }
  });

  it('nothing while the host is connected', () => {
    expect(
      evaluateHostLoss({
        hostAbsentSince: null,
        now: T0 + 10 * HOST_GRACE_MS,
        autoFailover: true,
        editors,
      }),
    ).toEqual({
      failover: null,
      pause: false,
    });
  });
});

describe.runIf(ADMIN_URL !== undefined)('host loss on Postgres 16', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await migratedDatabase(5);
  });
  afterAll(async () => {
    await test?.drop();
  });

  async function connectedSession() {
    const env = lifecycleOn(test.db);
    const w = await env.seed();
    const s = await env.service.create({
      workspaceId: w.workspace,
      creatorUserId: w.owner.user,
      creatorDeviceId: w.owner.device,
      name: 'Release train',
      region: 'eu',
    });
    await env.service.onHostConnected(s.id);
    env.relayed.length = 0;
    return { env, w, s };
  }

  it('599 s after the host left: live; at 600 s the sweep pauses it and notifies the relay once', async () => {
    const { env, s } = await connectedSession();
    const left = new Date(env.clock.now);
    await env.service.onHostDisconnected(s.id, left);
    await env.service.sweep(new Date(left.getTime() + 599_000));
    expect(await env.stateOf(s.id)).toBe('live');
    await env.service.sweep(new Date(left.getTime() + 600_000));
    expect(await env.stateOf(s.id)).toBe('paused');
    expect(env.relayed.filter((r) => r.sid === s.id)).toEqual([{ sid: s.id, state: 'paused' }]);
    await env.service.sweep(new Date(left.getTime() + 700_000));
    expect(env.relayed.filter((r) => r.sid === s.id)).toHaveLength(1);
  });

  it('a host who never connects: paused 10 min after the session was created', async () => {
    const env = lifecycleOn(test.db);
    const w = await env.seed();
    env.clock.now = T0 + 7 * 86_400_000;
    const s = await env.service.create({
      workspaceId: w.workspace,
      creatorUserId: w.owner.user,
      creatorDeviceId: w.owner.device,
      name: 'Never joined',
      region: 'eu',
    });
    await env.service.sweep(new Date(env.clock.now + HOST_GRACE_MS - 1_000));
    expect(await env.stateOf(s.id)).toBe('live');
    await env.service.sweep(new Date(env.clock.now + HOST_GRACE_MS));
    expect(await env.stateOf(s.id)).toBe('paused');
  });

  it('the host coming back to a paused session: live, exactly one live notification', async () => {
    const { env, s } = await connectedSession();
    await env.service.onHostDisconnected(s.id, new Date(env.clock.now));
    await env.service.sweep(new Date(env.clock.now + HOST_GRACE_MS));
    env.relayed.length = 0;
    env.clock.now += HOST_GRACE_MS + 5_000;
    expect((await env.service.onHostConnected(s.id))?.state).toBe('live');
    expect(env.relayed).toEqual([{ sid: s.id, state: 'live' }]);
    expect(env.events.filter((e) => e.type === 'session.started')).toHaveLength(1);
    // Connected again: no second notification.
    await env.service.onHostConnected(s.id);
    expect(env.relayed).toHaveLength(1);
  });

  it('hostLoss reads auto_failover from the session policy', async () => {
    const { env, s } = await connectedSession();
    const editor = { memberId: newId('mem'), connectedSince: T0 };
    await env.service.onHostDisconnected(s.id, new Date(env.clock.now));
    env.clock.now += FAILOVER_AFTER_MS;
    expect(await env.service.hostLoss(s.id, [editor])).toEqual({ failover: null, pause: false });
    await env.repository.setPolicy(s.id, {
      auto_approve: 'ask',
      share_history: false,
      queue_limit: 20,
      locked: false,
      auto_failover: true,
    });
    expect(await env.service.hostLoss(s.id, [editor])).toEqual({
      failover: editor.memberId,
      pause: false,
    });
  });
});

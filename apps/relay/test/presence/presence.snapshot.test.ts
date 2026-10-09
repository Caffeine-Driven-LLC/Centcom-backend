/**
 * The snapshot after a welcome (B047; tests "presence.snapshot.test.ts", acceptance 2): a joiner gets
 * exactly one presence frame per member that has published one (from the store, so other nodes'
 * members too, and this node's newer value over a stored older one), before any live presence;
 * presence that comes while the snapshot is read follows it. Nothing reaches a connection before
 * its welcome. On a running relay the presence frames come right after `sys.welcome`.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createPresence } from '../../src/presence/service.js';
import { presenceStage } from '../../src/presence/stage.js';
import { createMemoryPresenceStore, type PresenceStore } from '../../src/presence/store.js';
import type { RelayModule } from '../../src/modules.js';
import type { RoomRegistry } from '../../src/rooms/registry.js';
import { cluster } from '../cluster/helpers.js';
import { until } from '../helpers.js';
import { ONLINE_IDLE, presenceOf, presenceUnit } from './helpers.js';

describe('the snapshot (acceptance 2)', () => {
  it('one frame per member that published, before any live presence', async () => {
    let release: () => void = () => undefined;
    const memory = createMemoryPresenceStore();
    const slow: PresenceStore = {
      ...memory,
      write: (...a) => memory.write(...a),
      read: (sid) =>
        new Promise((resolve) => {
          release = () => void memory.read(sid).then(resolve);
        }),
    };
    const u = presenceUnit({ store: slow });
    const [a, b, quiet] = [u.join(), u.join(), u.join()];
    await u.update(a, { status: 'away', activity: 'idle' });
    await u.update(b, { status: 'busy', activity: 'running' });
    // Another node's member, in the store only (this store reads by the wall clock).
    const remote = newId('mem');
    await memory.write(u.sid, remote, { p: ONLINE_IDLE, at: Date.now(), node: 'node-b' });
    const joiner = u.join();
    const snapshot = u.presence.welcomed(joiner);
    // Live presence while the snapshot is read: held for the joiner.
    u.time.advance(1_500);
    await u.update(a, { status: 'online', activity: 'typing' });
    expect(presenceOf(joiner)).toEqual([]);
    release();
    await snapshot;
    const got = presenceOf(joiner);
    const first = got.slice(0, 3);
    expect(new Set(first.map(([m]) => m))).toEqual(
      new Set([a.entry.memberId, b.entry.memberId, remote]),
    );
    expect(first.some(([m]) => m === quiet.entry.memberId)).toBe(false);
    expect(got.slice(3)).toEqual([[a.entry.memberId, { status: 'online', activity: 'typing' }]]);
    expect(u.recorded.count('relay_presence_snapshots_total')).toBe(1);
  });

  it('this node’s newer value wins over an older stored one', async () => {
    const u = presenceUnit();
    const a = u.join();
    await u.update(a, { status: 'busy', activity: 'idle' });
    await u.store.write(u.sid, a.entry.memberId ?? '', {
      p: ONLINE_IDLE,
      at: u.time.now() - 10_000,
      node: 'node-b',
    });
    const joiner = u.join();
    await u.presence.welcomed(joiner);
    expect(presenceOf(joiner)).toEqual([[a.entry.memberId, { status: 'busy', activity: 'idle' }]]);
  });

  it('a joiner whose socket throws: welcomed resolves, the failures are counted', async () => {
    const u = presenceUnit();
    await u.update(u.join(), ONLINE_IDLE);
    await u.update(u.join(), { status: 'busy', activity: 'idle' });
    const joiner = u.join();
    joiner.failing = true;
    await expect(u.presence.welcomed(joiner)).resolves.toBeUndefined();
    expect(u.recorded.count('relay_presence_delivered_total', { result: 'error' })).toBe(2);
    // The joiner is no longer held: live presence reaches it once it works again.
    joiner.failing = false;
    u.time.advance(2_000);
    await u.update(u.join(), { status: 'away', activity: 'idle' });
    expect(presenceOf(joiner)).toHaveLength(1);
  });

  it('sends nothing to a connection before its welcome', async () => {
    const u = presenceUnit();
    const early = u.join();
    early.entry.state = 'open';
    await u.update(u.join(), ONLINE_IDLE);
    expect(presenceOf(early)).toEqual([]);
  });

  it('other nodes’ presence reaches welcomed connections, held while a snapshot is read', async () => {
    const u = presenceUnit();
    const watcher = u.join();
    const text = JSON.stringify({
      v: 1,
      t: 'presence',
      sid: u.sid,
      from: newId('mem'),
      k: 'presence.update',
      p: ONLINE_IDLE,
    });
    u.presence.receiveRemote(u.sid, text);
    u.presence.receiveRemote(u.sid, 'not json');
    expect(presenceOf(watcher)).toHaveLength(1);
  });
});

/** An in-memory presence module for one node of `c` (its rooms looked up once the node runs). */
function presenceModule(
  rooms: () => RoomRegistry,
  store = createMemoryPresenceStore(),
): RelayModule {
  return {
    name: 'presence',
    order: 35,
    register(ctx) {
      const presence = createPresence({
        store,
        rooms: { get: (sid) => rooms().get(sid) },
        config: { inMs: 0, outMs: 0, offlineGraceMs: 10_000 },
        nodeId: () => ctx.cluster?.nodeId ?? 'local',
        publish: (sid, frame) => void ctx.cluster?.publishEphemeral(sid, frame),
      });
      ctx.pipeline.use(35, presenceStage({ service: presence }));
      ctx.presence = presence;
      return undefined;
    },
  };
}

describe('on a running relay', () => {
  it('presence crosses nodes through the ephemeral channel, and into snapshots', async () => {
    const store = createMemoryPresenceStore();
    const nodes: RoomRegistry[] = [];
    let made = 0;
    const c = await cluster(2, {
      modules: () => {
        const index = made;
        made += 1;
        return [presenceModule(() => nodes[index] as RoomRegistry, store)];
      },
    });
    try {
      for (const node of c.nodes) nodes.push(node.rooms);
      const [a, b] = c.nodes as [(typeof c.nodes)[0], (typeof c.nodes)[0]];
      const onA = await c.client(a);
      const onB = await c.client(b);
      await onA.send('presence.update', { status: 'busy', activity: 'running' });
      await until(() => onB.wire.some((f) => f.t === 'presence' && f.from === onA.memberId));
      const joiner = await c.client(b);
      await until(() => joiner.wire.some((f) => f.t === 'presence'));
      expect(joiner.wire.find((f) => f.t === 'presence')).toMatchObject({
        from: onA.memberId,
        p: { status: 'busy', activity: 'running' },
      });
    } finally {
      await c.stop();
    }
  }, 30_000);

  it('a joiner gets the members’ presence right after sys.welcome', async () => {
    const legacyModule = (): RelayModule => ({
      name: 'presence',
      order: 35,
      register(ctx) {
        const presence = createPresence({
          store: createMemoryPresenceStore(),
          rooms: { get: (sid) => rooms().get(sid) },
          config: { inMs: 0, outMs: 0, offlineGraceMs: 10_000 },
          nodeId: () => 'node-a',
          publish: (sid, frame) => void ctx.cluster?.publishEphemeral(sid, frame),
        });
        ctx.pipeline.use(35, presenceStage({ service: presence }));
        ctx.presence = presence;
        return undefined;
      },
    });
    let rooms: () => RoomRegistry = () => {
      throw new Error('no rooms yet');
    };
    const c = await cluster(1, { modules: () => [legacyModule()] });
    try {
      const node = c.nodes[0] as (typeof c.nodes)[0];
      rooms = () => node.rooms;
      const a = await c.client(node);
      const b = await c.client(node);
      await a.send('presence.update', { status: 'away', activity: 'idle' });
      await b.send('presence.update', { status: 'busy', activity: 'reviewing' });
      await until(() => a.wire.filter((f) => f.t === 'presence').length >= 2);
      const joiner = await c.client(node);
      await until(() => joiner.wire.filter((f) => f.t === 'presence').length >= 2);
      const types = joiner.wire.map((f) => f.t);
      expect(types.slice(0, 3)).toEqual(['sys.welcome', 'presence', 'presence']);
      expect(joiner.wire.filter((f) => f.t === 'presence').every((f) => f.seq === undefined)).toBe(
        true,
      );
    } finally {
      await c.stop();
    }
  }, 30_000);
});

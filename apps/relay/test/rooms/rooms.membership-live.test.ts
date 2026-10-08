/**
 * Live membership (B043; tests "rooms.membership-live.test.ts"), with a fake clock:
 *
 * - a role changed to `viewer` in the records holds for the member's next privileged frame within
 *   2 s with no message, and at once with a `centcom:membership` message (acceptance 4);
 * - a `removed` (or `left`) message closes the user's connections in that workspace's sessions
 *   with 4403 and drops them from the room at once (acceptance 5);
 * - a member who is gone from the records is closed 4403 on their next frame (guardrail);
 * - the records failing: `sys.error service_unavailable`, the frame dropped, the connection kept
 *   (fail closed);
 * - the listener on the in-memory pub/sub, malformed messages ignored, and resubscribing with
 *   backoff when subscribing fails;
 * - the cache: at most 2 s old, one read for concurrent misses, failures not cached, bounded.
 */
import { createMemoryRedis, MEMBERSHIP_EVENTS_CHANNEL } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { parseMembershipEvent } from '../../src/rooms/authorise.js';
import { capRole, LiveMembership } from '../../src/rooms/membership.js';
import { errorsOf, fixtureFrame, newId, roomsHarness, until } from './helpers.js';

describe('role changes', () => {
  it('take effect within 2 s from the records alone (acceptance 4)', async () => {
    const h = roomsHarness();
    const { conn, mid, user } = await h.admit('editor');
    const prompt = () => fixtureFrame('message.user', h.sid);
    expect(await h.send(conn, prompt())).toBe(true);

    h.db.set(h.sid, mid, { role: 'viewer', userId: user, workspaceId: h.wsp });
    // Still cached for up to 2 s...
    h.clock.now += 1_999;
    expect(await h.send(conn, prompt())).toBe(true);
    // ...and no longer.
    h.clock.now += 1;
    expect(await h.send(conn, prompt())).toBe(false);
    expect(errorsOf(conn).at(-1)?.['p']).toMatchObject({ code: 'forbidden' });
    expect(h.registry.locate(conn)?.member.role).toBe('viewer');
    // A viewer's reaction still passes.
    expect(await h.send(conn, fixtureFrame('reaction', h.sid))).toBe(true);
  });

  it('take effect at once with the membership message (acceptance 4)', async () => {
    const h = roomsHarness();
    const { conn, mid, user } = await h.admit('editor');
    expect(await h.send(conn, fixtureFrame('queue.submit', h.sid))).toBe(true);
    h.db.set(h.sid, mid, { role: 'viewer', userId: user, workspaceId: h.wsp });
    const before = Date.now();
    await h.rooms.onMembershipEvent({
      type: 'role_changed',
      wsp: h.wsp,
      mem: newId('mem'),
      user,
      role: 'guest',
      at: new Date().toISOString(),
    });
    expect(await h.send(conn, fixtureFrame('queue.submit', h.sid))).toBe(false);
    expect(Date.now() - before).toBeLessThan(200);
  });

  it('closes a member whose new role keeps them out of sessions', async () => {
    const h = roomsHarness();
    const { conn, mid, user } = await h.admit('editor');
    h.db.set(h.sid, mid, null);
    await h.rooms.onMembershipEvent({
      type: 'role_changed',
      wsp: h.wsp,
      mem: newId('mem'),
      user,
      role: 'billing',
      at: new Date().toISOString(),
    });
    expect(conn.closedWith).toBe(4403);
  });

  it('caps the session role by the workspace role (CT-RBAC matrix)', () => {
    expect(capRole('editor', 'guest')).toBe('viewer');
    expect(capRole('host', 'billing')).toBeNull();
    expect(capRole('host', 'owner')).toBe('host');
    expect(capRole('viewer', null)).toBe('viewer');
  });
});

describe('removal', () => {
  it('closes the user’s connections with 4403 within 500 ms and drops them (acceptance 5)', async () => {
    const h = roomsHarness();
    const user = newId('usr');
    const mid = newId('mem');
    const laptop = await h.admit('editor', { mid, user });
    const phone = await h.admit('editor', { mid, user });
    const other = await h.admit('editor');
    expect(h.registry.get(h.sid)?.memberCount()).toBe(2);

    const before = Date.now();
    await h.rooms.onMembershipEvent({
      type: 'removed',
      wsp: h.wsp,
      mem: newId('mem'),
      user,
      at: new Date().toISOString(),
    });
    expect(Date.now() - before).toBeLessThan(500);
    for (const { conn } of [laptop, phone]) {
      expect(conn.closedWith).toBe(4403);
      expect(errorsOf(conn).at(-1)?.['p']).toMatchObject({ code: 'not_a_member' });
      expect(h.registry.locate(conn)).toBeUndefined();
    }
    expect(other.conn.closedWith).toBeNull();
    expect(
      h.registry
        .get(h.sid)
        ?.members()
        .map((m) => m.id),
    ).toEqual([other.mid]);
  });

  it('only touches sessions of the workspace the user left', async () => {
    const h = roomsHarness();
    const { conn, user } = await h.admit('editor');
    await h.rooms.onMembershipEvent({
      type: 'left',
      wsp: newId('wsp'),
      mem: newId('mem'),
      user,
      at: new Date().toISOString(),
    });
    expect(conn.closedWith).toBeNull();
  });

  it('closes a member gone from the records on their next frame (guardrail)', async () => {
    const h = roomsHarness();
    const { conn, mid } = await h.admit('editor');
    h.db.set(h.sid, mid, null);
    h.clock.now += 2_000;
    expect(await h.send(conn, fixtureFrame('reaction', h.sid))).toBe(false);
    expect(conn.closedWith).toBe(4403);
  });
});

describe('failures', () => {
  it('fails closed when the records cannot be read, keeping the connection', async () => {
    const h = roomsHarness();
    const { conn } = await h.admit('host');
    h.db.state.fail = true;
    h.clock.now += 2_000;
    const frame = fixtureFrame('control.end', h.sid);
    expect(await h.send(conn, frame)).toBe(false);
    expect(errorsOf(conn).at(-1)).toMatchObject({
      ref: frame['id'],
      p: { code: 'service_unavailable', retry_after_s: 1 },
    });
    expect(conn.closedWith).toBeNull();
    // Once the records answer again, frames pass.
    h.db.state.fail = false;
    expect(await h.send(conn, frame)).toBe(true);
  });

  it('refuses a frame from a connection that never joined a room', async () => {
    const h = roomsHarness();
    const { fakeConnection } = await import('./helpers.js');
    const conn = fakeConnection(h.sid);
    expect(await h.send(conn, fixtureFrame('reaction', h.sid))).toBe(false);
    expect(errorsOf(conn).at(-1)?.['p']).toMatchObject({ code: 'forbidden' });
  });

  it('lets sys frames and acks through without a membership read', async () => {
    const h = roomsHarness();
    const { conn } = await h.admit('viewer');
    const reads = h.db.state.reads;
    h.db.state.fail = true;
    expect(await h.send(conn, { v: 1, t: 'sys.ping', p: { t: 1 } })).toBe(true);
    expect(await h.send(conn, { v: 1, t: 'ack', ack: 3 })).toBe(true);
    expect(h.db.state.reads).toBe(reads);
  });
});

describe('the centcom:membership listener', () => {
  it('reacts to published messages and ignores malformed ones', async () => {
    const h = roomsHarness();
    const redis = createMemoryRedis();
    const listener = h.rooms.listen(redis.pubsub);
    const { conn, user } = await h.admit('editor');
    // Let the subscription settle, then publish.
    await new Promise((resolve) => setImmediate(resolve));
    await redis.pubsub.publish(MEMBERSHIP_EVENTS_CHANNEL, 'not json');
    await redis.pubsub.publish(
      MEMBERSHIP_EVENTS_CHANNEL,
      JSON.stringify({ type: 'removed', wsp: h.wsp, mem: newId('mem'), user, at: 'x' }),
    );
    await until(() => conn.closedWith !== null, 2_000);
    expect(conn.closedWith).toBe(4403);
    await listener.stop();
  });

  it('resubscribes with backoff when subscribing fails', async () => {
    const h = roomsHarness();
    let attempts = 0;
    const pubsub = {
      subscribe: () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(new Error('redis down'))
          : Promise.resolve(() => Promise.resolve());
      },
    };
    const listener = h.rooms.listen(pubsub);
    await until(() => h.timers.pending() === 1, 1_000);
    h.timers.advance(1_000);
    await until(() => attempts === 2 && h.timers.pending() === 1, 1_000);
    h.timers.advance(2_000);
    await until(() => attempts === 3, 1_000);
    await listener.stop();
  });

  it('parses only well-formed events', () => {
    const wsp = newId('wsp');
    const mem = newId('mem');
    const user = newId('usr');
    expect(
      parseMembershipEvent(JSON.stringify({ type: 'left', wsp, mem, user, at: 'now' })),
    ).toEqual({ type: 'left', wsp, mem, user, at: 'now' });
    expect(parseMembershipEvent(JSON.stringify({ type: 'joined', wsp, mem, user }))).toBeNull();
    expect(parseMembershipEvent(JSON.stringify({ type: 'left', wsp: 'x', mem, user }))).toBeNull();
    expect(parseMembershipEvent('[]')).toBeNull();
    expect(parseMembershipEvent('{')).toBeNull();
  });
});

describe('LiveMembership', () => {
  it('serves at most 2 s old answers, shares concurrent reads, and never caches a failure', async () => {
    let now = 0;
    let reads = 0;
    let fail = false;
    const cache = new LiveMembership({
      source: {
        lookup: () => {
          reads += 1;
          return fail
            ? Promise.reject(new Error('down'))
            : Promise.resolve({ role: 'editor', userId: 'usr_x', workspaceId: null });
        },
      },
      clock: () => now,
      maxEntries: 2,
    });
    await Promise.all([cache.get('s', 'a'), cache.get('s', 'a')]);
    expect(reads).toBe(1);
    now = 1_999;
    await cache.get('s', 'a');
    expect(reads).toBe(1);
    now = 2_000;
    fail = true;
    await expect(cache.get('s', 'a')).rejects.toThrow('down');
    await expect(cache.get('s', 'a')).rejects.toThrow('down');
    expect(reads).toBe(3);
    fail = false;
    await cache.get('s', 'b');
    await cache.get('s', 'c');
    await cache.get('s', 'd');
    expect(cache.size).toBe(2);
    expect(
      () => new LiveMembership({ source: { lookup: () => Promise.resolve(null) }, ttlMs: 2_001 }),
    ).toThrow(TypeError);
  });

  it('does not cache a read that started before an invalidation', async () => {
    let release: () => void = () => undefined;
    let reads = 0;
    const cache = new LiveMembership({
      source: {
        lookup: () => {
          reads += 1;
          return new Promise((resolve) => {
            release = () => resolve({ role: 'editor', userId: 'usr_x', workspaceId: null });
          });
        },
      },
      clock: () => 0,
    });
    const pending = cache.get('s', 'a');
    cache.invalidateUser('usr_x');
    release();
    await pending;
    // The first answer was not cached: this reads again.
    const second = cache.get('s', 'a');
    release();
    await second;
    expect(reads).toBe(2);
  });
});

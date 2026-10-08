/**
 * Room lifecycle (B043; tests "rooms.lifecycle.test.ts", acceptance 8): a room is created on the
 * first join and evicted 60 s (±1 s) after its last connection left, unless someone joins first;
 * 10 000 join/leave cycles leave `count()` at 0 once the eviction timer has run; a join racing an
 * eviction gets a fresh room (`getOrCreate` is synchronous); `closeMember` closes and drops every
 * connection of a member.
 */
import { describe, expect, it } from 'vitest';
import {
  createRoomRegistry,
  ROOM_EVICT_AFTER_MS,
  type MemberView,
} from '../../src/rooms/registry.js';
import { fakeConnection, manualTimers, newId } from './helpers.js';

const member = (sid: string, over: Partial<MemberView> = {}): MemberView => ({
  id: newId('mem'),
  sid,
  role: 'editor',
  userId: newId('usr'),
  workspaceId: newId('wsp'),
  name: 'Alex',
  slot: 0,
  ...over,
});

describe('room lifecycle', () => {
  it('creates a room on first join and evicts it 60 s after the last leave', () => {
    const timers = manualTimers();
    const registry = createRoomRegistry({ setTimer: timers.setTimer });
    const sid = newId('ses');
    expect(registry.get(sid)).toBeUndefined();
    const room = registry.getOrCreate(sid);
    const conn = fakeConnection(sid);
    room.join(conn, member(sid));
    expect(registry.count()).toBe(1);
    room.leave(conn);
    room.leave(conn); // idempotent
    timers.advance(ROOM_EVICT_AFTER_MS - 1_000);
    expect(registry.count()).toBe(1);
    timers.advance(999);
    expect(registry.count()).toBe(1);
    timers.advance(1);
    expect(registry.count()).toBe(0);
    expect(ROOM_EVICT_AFTER_MS).toBe(60_000);
  });

  it('keeps a room someone rejoins before the eviction', () => {
    const timers = manualTimers();
    const registry = createRoomRegistry({ setTimer: timers.setTimer });
    const sid = newId('ses');
    const room = registry.getOrCreate(sid);
    const a = fakeConnection(sid);
    room.join(a, member(sid));
    room.leave(a);
    timers.advance(30_000);
    const b = fakeConnection(sid);
    registry.getOrCreate(sid).join(b, member(sid));
    timers.advance(60_000);
    expect(registry.get(sid)).toBe(room);
    expect([...room.connections()]).toEqual([b]);
  });

  it('gives a join after the eviction a fresh room', () => {
    const timers = manualTimers();
    const registry = createRoomRegistry({ setTimer: timers.setTimer });
    const sid = newId('ses');
    const old = registry.getOrCreate(sid);
    const a = fakeConnection(sid);
    old.join(a, member(sid));
    old.leave(a);
    timers.advance(60_000);
    const fresh = registry.getOrCreate(sid);
    expect(fresh).not.toBe(old);
    expect(fresh.memberCount()).toBe(0);
  });

  it('leaves nothing behind after 10 000 join/leave cycles', () => {
    const timers = manualTimers();
    const registry = createRoomRegistry({ setTimer: timers.setTimer });
    const sids = Array.from({ length: 100 }, () => newId('ses'));
    for (let i = 0; i < 10_000; i++) {
      const sid = sids[i % sids.length] ?? '';
      const conn = fakeConnection(sid);
      registry.getOrCreate(sid).join(conn, member(sid));
      registry.locate(conn)?.room.leave(conn);
    }
    expect(registry.count()).toBe(100);
    timers.advance(60_000);
    expect(registry.count()).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  it('tracks a member’s devices and closes them all with closeMember', () => {
    const registry = createRoomRegistry({ setTimer: manualTimers().setTimer });
    const sid = newId('ses');
    const room = registry.getOrCreate(sid);
    const m = member(sid);
    const laptop = fakeConnection(sid);
    const phone = fakeConnection(sid);
    room.join(laptop, m);
    room.join(phone, m);
    expect(room.memberCount()).toBe(1);
    expect(room.connectionsOf(m.id)).toEqual([laptop, phone]);
    expect(room.members()).toEqual([{ ...m }]);
    room.setRole(m.id, 'viewer');
    expect(room.memberOf(laptop)?.role).toBe('viewer');
    room.closeMember(m.id, 4404);
    expect([laptop.closedWith, phone.closedWith]).toEqual([4404, 4404]);
    expect(laptop.sent.at(-1)).toMatchObject({ t: 'sys.error', p: { code: 'session_ended' } });
    expect(room.memberCount()).toBe(0);
    expect(registry.locate(laptop)).toBeUndefined();
    // Nothing for an unknown member.
    room.closeMember(newId('mem'), 4403);
    room.setRole(newId('mem'), 'host');
  });

  it('moves a connection that joins another room out of the first', () => {
    const registry = createRoomRegistry({ setTimer: manualTimers().setTimer });
    const a = newId('ses');
    const b = newId('ses');
    const conn = fakeConnection(a);
    registry.getOrCreate(a).join(conn, member(a));
    registry.getOrCreate(b).join(conn, member(b));
    expect(registry.get(a)?.memberCount()).toBe(0);
    expect(registry.locate(conn)?.room.sid).toBe(b);
  });
});

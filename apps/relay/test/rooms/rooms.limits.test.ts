/**
 * Member limits (B043; tests "rooms.limits.test.ts", acceptance 6): the 51st distinct member of a
 * session is refused (`session_full`, close 4403) whatever the plan; `max_session_members` 4
 * refuses the 5th; a member's further devices are never counted again; a seat freed by a leave can
 * be taken; `roomHasSpace` is the check `SessionAccess` and the join both use.
 */
import { describe, expect, it } from 'vitest';
import { roomHasSpace } from '../../src/rooms/access.js';
import { newId, roomsHarness } from './helpers.js';

describe('member limits', () => {
  it('refuses the 51st distinct member, whatever the plan allows', async () => {
    const h = roomsHarness();
    for (let i = 0; i < 50; i++) {
      expect((await h.admit('editor', { maxMembers: 500 })).decision).toEqual({ ok: true });
    }
    const late = await h.admit('editor', { maxMembers: 500 });
    expect(late.decision).toMatchObject({ ok: false, code: 'session_full' });
    expect(h.registry.locate(late.conn)).toBeUndefined();
    expect(h.registry.get(h.sid)?.memberCount()).toBe(50);
  });

  it('refuses the 5th with max_session_members 4; devices of a member count once', async () => {
    const h = roomsHarness();
    const first = await h.admit('host', { maxMembers: 4 });
    for (let i = 0; i < 3; i++) await h.admit('editor', { maxMembers: 4 });
    expect((await h.admit('editor', { maxMembers: 4 })).decision).toMatchObject({
      ok: false,
      code: 'session_full',
    });
    const secondDevice = await h.admit('host', {
      maxMembers: 4,
      mid: first.mid,
      user: first.user,
    });
    expect(secondDevice.decision).toEqual({ ok: true });
    expect(h.registry.get(h.sid)?.connectionsOf(first.mid)).toHaveLength(2);
    expect(h.registry.get(h.sid)?.memberCount()).toBe(4);

    // A member who leaves frees their place.
    first.conn.close(1000 as never);
    secondDevice.conn.close(1000 as never);
    expect((await h.admit('editor', { maxMembers: 4 })).decision).toEqual({ ok: true });
  });

  it('refuses a member the records no longer have', async () => {
    const h = roomsHarness();
    const mid = newId('mem');
    h.db.set(h.sid, mid, null);
    const { decision } = await h.admit('editor', { mid });
    expect(decision).toMatchObject({ ok: false, code: 'not_a_member' });
  });

  it('roomHasSpace caps at 50 and lets a present member in', () => {
    const room = { hasMember: (m: string) => m === 'in', memberCount: () => 50 };
    expect(roomHasSpace(room, 'in', 500)).toBe(true);
    expect(roomHasSpace(room, 'out', 500)).toBe(false);
    expect(roomHasSpace({ ...room, memberCount: () => 49 }, 'out', 500)).toBe(true);
    expect(roomHasSpace({ ...room, memberCount: () => 3 }, 'out', 3)).toBe(false);
  });
});

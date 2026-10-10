/**
 * Control authority (B051; tests "control.authority.test.ts"):
 *
 * - the role matrix: every client control kind from a viewer or an editor is `sys.error forbidden`
 *   to that sender only, gets no `seq`, and writes one `control.<kind>` audit event (denied);
 * - the live-role recheck: a host demoted a moment ago (still "host" in B043's 2 s cache) is
 *   refused by the fresh read at sequencing time;
 * - a concurrent change between the check and the effect makes the effect a no-op (`conflict`);
 * - targets: unknown, left, or the sender themselves;
 * - `control.role` to viewer: the target's very next event frame fails authorisation (acceptance
 *   5), because this node's cached role is read again at once;
 * - records unreadable: `service_unavailable`, nothing sequenced.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { CLIENT_CONTROL_KINDS } from '../../src/control/authority.js';
import { controlUnit } from './helpers.js';

/** A valid payload of `kind` aimed at `target`. */
function payload(kind: string, target: string): Record<string, unknown> {
  switch (kind) {
    case 'control.kick':
      return { member: target, code: 'abuse' };
    case 'control.mute':
    case 'control.unmute':
      return { member: target };
    case 'control.role':
      return { member: target, role: 'viewer' };
    case 'control.transfer_host':
      return { to: target };
    case 'control.end':
      return { code: 'done' };
    default:
      return { auto_approve: 'ask', share_history: false, queue_limit: 5 };
  }
}

describe('the role matrix', () => {
  for (const kind of CLIENT_CONTROL_KINDS) {
    for (const role of ['viewer', 'editor'] as const) {
      it(`${kind} from a ${role}: forbidden to that sender only, no seq, one denied audit event`, async () => {
        const u = controlUnit();
        const sender = u.member(role);
        const other = u.member('editor');
        const frame = u.ctl(kind, payload(kind, other.mid));
        expect(await u.send(sender.conn, frame)).toBeUndefined();
        expect(u.errorsOf(sender.conn).map((p) => p['code'])).toEqual(['forbidden']);
        expect(u.errorsOf(other.conn)).toEqual([]);
        expect(await u.store.head(u.sid)).toBe(0);
        expect(u.audited).toHaveLength(1);
        expect(u.audited[0]).toMatchObject({
          action: kind,
          outcome: 'denied',
          actor: { type: 'user', id: sender.userId },
        });
        expect(u.recorded.count('relay_control_frames_total', { kind, outcome: 'denied' })).toBe(1);
      });
    }

    it(`${kind} from the host is sequenced`, async () => {
      const u = controlUnit();
      const host = u.member('host');
      const other = u.member('editor');
      const stored = await u.send(host.conn, u.ctl(kind, payload(kind, other.mid)));
      expect(stored?.seq).toBe(1);
      expect(stored?.k).toBe(kind);
      expect(u.errorsOf(host.conn)).toEqual([]);
      expect(u.events(kind).map((e) => e.outcome)).toEqual(['success']);
    });
  }

  it('refuses a client’s server-only control kinds (B043), auditing them as permission.denied', async () => {
    const u = controlUnit();
    const host = u.member('host');
    for (const kind of ['control.member_left', 'control.rotate_key', 'control.host_changed']) {
      await u.send(host.conn, u.ctl(kind, { member: host.mid, code: 'left' }));
    }
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual([
      'forbidden',
      'forbidden',
      'forbidden',
    ]);
    expect(await u.store.head(u.sid)).toBe(0);
    expect(u.events('permission.denied')).toHaveLength(3);
  });
});

describe('the live-role recheck', () => {
  it('refuses a host demoted since B043’s cached read, at sequencing time', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    // B043 caches "host" for up to 2 s.
    await u.send(host.conn, u.presence());
    u.db.row(u.sid, host.mid).role = 'editor';
    expect(
      await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' })),
    ).toBeUndefined();
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['forbidden']);
    expect(await u.store.head(u.sid)).toBe(0);
    expect(target.conn.closedWith).toBeNull();
    expect(u.events('control.kick').map((e) => e.outcome)).toEqual(['denied']);
  });

  it('makes the effect a no-op when the target changes between the check and the effect', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const get = u.db.port.get;
    // The target leaves right after the check read them.
    u.db.port.get = async (sid, mid) => {
      const live = await get(sid, mid);
      if (mid === target.mid) u.db.row(sid, mid).left = true;
      return live;
    };
    const stored = await u.send(
      host.conn,
      u.ctl('control.role', { member: target.mid, role: 'viewer' }),
    );
    expect(stored?.seq).toBe(1);
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['conflict']);
    expect(u.db.role(u.sid, target.mid)).toBe('editor');
    expect(u.events('control.role').map((e) => e.outcome)).toEqual(['failed']);
  });

  it('a host and a concurrent demotion: exactly one of them wins', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const kick = u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' }));
    // The demotion lands while the frame waits for B043's read.
    u.db.row(u.sid, host.mid).role = 'viewer';
    await kick;
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['forbidden']);
    expect(target.conn.closedWith).toBeNull();
    expect(u.db.left(u.sid, target.mid)).toBe(false);
  });
});

describe('targets', () => {
  it('refuses an unknown member, a member who left, and the sender, changing nothing', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const gone = u.member('editor');
    u.db.row(u.sid, gone.mid).left = true;
    await u.send(host.conn, u.ctl('control.kick', { member: newId('mem'), code: 'other' }));
    await u.send(host.conn, u.ctl('control.kick', { member: gone.mid, code: 'other' }));
    await u.send(host.conn, u.ctl('control.mute', { member: host.mid }));
    await u.send(host.conn, u.ctl('control.role', { member: host.mid, role: 'viewer' }));
    const errors = u.errorsOf(host.conn);
    expect(errors.map((p) => p['code'])).toEqual([
      'not_found',
      'not_found',
      'conflict',
      'conflict',
    ]);
    expect(errors.map((p) => (p['errors'] as { pointer: string }[])[0]?.pointer)).toEqual([
      '/p/member',
      '/p/member',
      '/p/member',
      '/p/member',
    ]);
    expect(await u.store.head(u.sid)).toBe(0);
    expect((await u.epochs.current(u.sid)).kid).toBe('k1');
    expect(u.db.role(u.sid, host.mid)).toBe('host');
  });
});

describe('control.role', () => {
  it('makes the target’s next event frame fail authorisation (live membership read again)', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const editor = u.member('editor');
    expect((await u.send(editor.conn, u.event()))?.seq).toBe(1);
    const changed = await u.send(
      host.conn,
      u.ctl('control.role', { member: editor.mid, role: 'viewer' }),
    );
    expect(changed?.seq).toBe(2);
    expect(u.db.role(u.sid, editor.mid)).toBe('viewer');
    // Well inside B043's 2 s cache: the change still holds from the very next frame.
    expect(await u.send(editor.conn, u.event())).toBeUndefined();
    expect(u.errorsOf(editor.conn).map((p) => p['code'])).toEqual(['forbidden']);
    // A viewer may still react.
    expect(u.rooms.get(u.sid)?.memberOf(editor.conn)?.role).toBe('viewer');
  });

  it('back to editor lets the member send again', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const viewer = u.member('viewer');
    expect(await u.send(viewer.conn, u.event())).toBeUndefined();
    await u.send(host.conn, u.ctl('control.role', { member: viewer.mid, role: 'editor' }));
    expect((await u.send(viewer.conn, u.event()))?.seq).toBe(2);
  });
});

describe('records unreadable', () => {
  it('answers service_unavailable and sequences nothing', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    await u.send(host.conn, u.presence());
    u.db.state.failing = true;
    expect(
      await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' })),
    ).toBeUndefined();
    const [error] = u.errorsOf(host.conn);
    expect(error).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    expect(await u.store.head(u.sid)).toBe(0);
    expect(target.conn.closedWith).toBeNull();
    expect(u.events('control.kick').map((e) => e.outcome)).toEqual(['failed']);
  });
});

/**
 * Host transfer and session end (B051; tests "control.transfer-end.test.ts", acceptance 6 and 7):
 *
 * - `control.transfer_host` to a connected editor: exactly one `control.host_changed {host, code:
 *   transfer}` from `srv`, roles swapped; the old host's kick is then refused, the new host's
 *   works; to a viewer, to self, to an offline editor: refused, nothing changed;
 * - atomicity: `host_changed` failing to go out undoes the swap;
 * - `control.end`: the session ends (SessionStatePort), `control.session_state {state: ended}`,
 *   every socket closed 1000, later frames close 4404; failing to emit puts the state back.
 */
import { describe, expect, it } from 'vitest';
import { controlUnit } from './helpers.js';

describe('control.transfer_host', () => {
  it('to a connected editor: one host_changed, roles swapped, the old host loses authority', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const editor = u.member('editor');
    const third = u.member('editor');
    const transfer = await u.send(host.conn, u.ctl('control.transfer_host', { to: editor.mid }));
    expect(transfer?.seq).toBe(1);
    const changed = (await u.sequenced()).filter((f) => f.k === 'control.host_changed');
    expect(changed).toEqual([
      expect.objectContaining({ seq: 2, from: 'srv', p: { host: editor.mid, code: 'transfer' } }),
    ]);
    expect(u.db.role(u.sid, host.mid)).toBe('editor');
    expect(u.db.role(u.sid, editor.mid)).toBe('host');
    expect(u.rooms.get(u.sid)?.memberOf(host.conn)?.role).toBe('editor');
    expect(u.rooms.get(u.sid)?.memberOf(editor.conn)?.role).toBe('host');

    await u.send(host.conn, u.ctl('control.kick', { member: third.mid, code: 'other' }));
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['forbidden']);
    expect(third.conn.closedWith).toBeNull();

    await u.send(editor.conn, u.ctl('control.kick', { member: third.mid, code: 'other' }));
    expect(third.conn.closedWith).toBe(4403);
    expect(u.events('control.transfer_host')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        target: { type: 'session_member', id: editor.mid },
        meta: { session_id: u.sid, code: 'transfer' },
      }),
    ]);
  });

  it('to a viewer, to self, or to an offline editor: refused, state unchanged', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const viewer = u.member('viewer');
    const offline = u.member('editor', { connected: false });
    await u.send(host.conn, u.ctl('control.transfer_host', { to: viewer.mid }));
    await u.send(host.conn, u.ctl('control.transfer_host', { to: host.mid }));
    await u.send(host.conn, u.ctl('control.transfer_host', { to: offline.mid }));
    const errors = u.errorsOf(host.conn);
    expect(errors.map((p) => p['code'])).toEqual(['conflict', 'conflict', 'conflict']);
    expect(errors.map((p) => p['detail'])).toEqual([
      'The host role can only go to an editor.',
      'You cannot do that to yourself.',
      'The host role can only go to a member who is connected.',
    ]);
    expect(await u.store.head(u.sid)).toBe(0);
    expect(u.db.role(u.sid, host.mid)).toBe('host');
    expect(u.db.role(u.sid, viewer.mid)).toBe('viewer');
    expect(u.db.role(u.sid, offline.mid)).toBe('editor');
  });

  it('undoes the swap when host_changed cannot be sequenced', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const editor = u.member('editor');
    u.failures.emit = true;
    await u.send(host.conn, u.ctl('control.transfer_host', { to: editor.mid }));
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['service_unavailable']);
    expect(u.db.role(u.sid, host.mid)).toBe('host');
    expect(u.db.role(u.sid, editor.mid)).toBe('editor');
    expect(u.rooms.get(u.sid)?.memberOf(host.conn)?.role).toBe('host');
    expect((await u.sequenced()).some((f) => f.k === 'control.host_changed')).toBe(false);
    expect(u.events('control.transfer_host').map((e) => e.outcome)).toEqual(['failed']);
  });
});

describe('control.end', () => {
  it('ends the session, emits session_state ended, closes every socket 1000; later frames close 4404', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const a = u.member('editor');
    const b = u.member('viewer');
    const end = await u.send(host.conn, u.ctl('control.end', { code: 'done' }));
    expect(end?.seq).toBe(1);
    expect(u.sessions.states.get(u.sid)).toBe('ended');
    const frames = await u.sequenced();
    expect(frames.map((f) => f.k)).toEqual(['control.end', 'control.session_state']);
    expect(frames[1]).toMatchObject({ from: 'srv', p: { state: 'ended' } });
    // Everyone got the state before the close.
    for (const m of [host, a, b]) {
      expect(m.conn.seqs()).toEqual([1, 2]);
      expect(m.conn.closedWith).toBe(1000);
    }
    // A connection that slipped in (another node's, in production): its frame closes it 4404.
    const late = u.member('editor', { mid: a.mid });
    expect(await u.send(late.conn, u.event())).toBeUndefined();
    expect(late.conn.closedWith).toBe(4404);
    expect(late.conn.frames().at(-1)).toMatchObject({
      t: 'sys.error',
      p: { code: 'session_ended' },
    });
    expect(u.events('control.end')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        target: { type: 'session', id: u.sid },
        meta: { session_id: u.sid, code: 'done' },
      }),
    ]);
  });

  it('puts the state back and closes nothing when session_state cannot be sequenced', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const a = u.member('editor');
    u.failures.emit = true;
    await u.send(host.conn, u.ctl('control.end', { code: 'abandoned' }));
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['service_unavailable']);
    expect(u.sessions.states.get(u.sid)).toBe('live');
    expect(a.conn.closedWith).toBeNull();
    expect((await u.send(a.conn, u.event()))?.seq).toBe(2);
  });

  it('an already ended session: session_ended, nothing emitted', async () => {
    const u = controlUnit();
    const host = u.member('host');
    u.sessions.states.set(u.sid, 'ended');
    await u.send(host.conn, u.ctl('control.end', { code: 'done' }));
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['session_ended']);
    expect((await u.sequenced()).map((f) => f.k)).toEqual(['control.end']);
    expect(host.conn.closedWith).toBeNull();
  });
});

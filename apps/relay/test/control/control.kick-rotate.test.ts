/**
 * Kick and key rotation (B051; tests "control.kick-rotate.test.ts", acceptance 2 and 3, the kick's
 * failure modes):
 *
 * - the target's connections close 4403 well within 500 ms;
 * - `control.member_left {member, code: kicked}` and `control.rotate_key {kid: k2, reason:
 *   member_removed}` from `srv` at `seq` n and n+1, nothing between them, under 50 concurrent
 *   editor frames, and as a fast-check property over 100 random editor frames;
 * - a reconnect is refused (`not_a_member`, close 4403); kicking an unknown or departed member
 *   changes nothing;
 * - the sequencer failing: for the kick, B041's 503 and nothing applied; for the pair, 503 and
 *   the removal undone (the member, already closed, may reconnect);
 * - the target already offline: still removed, both frames emitted;
 * - a resend of the same kick: no second rotation.
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoredFrame } from '../../src/seq/types.js';
import { controlUnit } from './helpers.js';

const SRV = 'srv';

/** The member_left at `n` and the rotate_key at `n + 1` of `frames`, checked adjacent. */
function kickPair(frames: StoredFrame[], member: string) {
  const at = frames.findIndex((f) => f.k === 'control.member_left');
  expect(at).toBeGreaterThanOrEqual(0);
  const left = frames[at] as StoredFrame & { p: Record<string, unknown> };
  const rotate = frames[at + 1] as StoredFrame & { p: Record<string, unknown> };
  expect(left).toMatchObject({ from: SRV, p: { member, code: 'kicked' } });
  expect(rotate).toMatchObject({
    from: SRV,
    k: 'control.rotate_key',
    p: { kid: 'k2', reason: 'member_removed' },
  });
  expect(rotate.seq).toBe(left.seq + 1);
  return { left, rotate };
}

describe('a host kick', () => {
  it('closes the target 4403 within 500 ms, then emits member_left and rotate_key at n and n+1', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const bystander = u.member('viewer');
    const started = performance.now();
    const kick = await u.send(
      host.conn,
      u.ctl('control.kick', { member: target.mid, code: 'abuse' }),
    );
    expect(target.conn.closedWith).toBe(4403);
    expect(performance.now() - started).toBeLessThan(500);
    expect(kick?.seq).toBe(1);
    const frames = await u.sequenced();
    const { left, rotate } = kickPair(frames, target.mid);
    expect([left.seq, rotate.seq]).toEqual([2, 3]);
    // The others received all three, in order.
    expect(bystander.conn.seqs()).toEqual([1, 2, 3]);
    // The target got not_a_member before the close.
    expect(target.conn.frames().at(-1)).toMatchObject({
      t: 'sys.error',
      p: { code: 'not_a_member' },
    });
    expect(u.db.left(u.sid, target.mid)).toBe(true);
    expect((await u.epochs.current(u.sid)).kid).toBe('k2');
    expect(u.events('control.kick')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        target: { type: 'session_member', id: target.mid },
        meta: { session_id: u.sid, code: 'abuse' },
      }),
    ]);
  });

  it('keeps member_left and rotate_key adjacent under 50 concurrent editor frames', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const editors = Array.from({ length: 5 }, () => u.member('editor'));
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const e = editors[i % editors.length];
      if (e === undefined) continue;
      sends.push(u.send(e.conn, u.event()));
      if (i === 25) {
        sends.push(u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' })));
      }
    }
    await Promise.all(sends);
    const frames = await u.sequenced();
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
    expect(frames.filter((f) => f.k === 'message.user')).toHaveLength(50);
    kickPair(frames, target.mid);
    expect(target.conn.closedWith).toBe(4403);
  });

  it('property: with 100 random editor frames around it, the pair is always adjacent and seq contiguous', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(3), { minLength: 100, maxLength: 100 }),
        fc.nat(99),
        fc.array(fc.boolean(), { minLength: 100, maxLength: 100 }),
        async (who, kickAt, awaitEach) => {
          const u = controlUnit();
          const host = u.member('host');
          const target = u.member('editor');
          const editors = Array.from({ length: 4 }, () => u.member('editor'));
          const pending: Promise<unknown>[] = [];
          for (let i = 0; i < 100; i += 1) {
            const e = editors[who[i] ?? 0];
            if (e === undefined) continue;
            const sent = u.send(e.conn, u.event());
            if (awaitEach[i] === true) await sent;
            else pending.push(sent);
            if (i === kickAt) {
              pending.push(
                u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' })),
              );
            }
          }
          await Promise.all(pending);
          const frames = await u.sequenced();
          expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
          expect(frames).toHaveLength(103);
          kickPair(frames, target.mid);
          // Nothing reached the target after its close.
          expect(target.conn.frames().some((f) => f['k'] === 'control.rotate_key')).toBe(false);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('after a kick', () => {
  it('refuses the member’s reconnect: not_a_member (the handshake closes 4403)', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'request' }));
    const fresh = u.member('editor', { mid: target.mid, connected: false });
    const decision = await u.roomSide.onAdmitted(fresh.conn, {
      sid: u.sid,
      dev: newId('dev'),
      access: {
        session: { state: 'live', maxMembers: 50 },
        member: { id: target.mid, name: 'M', slot: 0, role: 'editor' },
        deviceRevoked: false,
        relayAccess: true,
      },
      lastSeq: null,
    });
    expect(decision).toMatchObject({ ok: false, code: 'not_a_member' });
  });

  it('a kicked member’s other open connection is closed 4403 on its next frame', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    // A second device that the kick's close did not reach (another node, in production).
    const other = u.member('editor', { mid: target.mid });
    u.connections.closeMember = () => Promise.resolve();
    await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' }));
    expect(other.conn.closedWith).toBeNull();
    expect(await u.send(other.conn, u.event())).toBeUndefined();
    expect(other.conn.closedWith).toBe(4403);
  });

  it('kicking an unknown or departed member: sys.error, no seq, no rotation', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' }));
    const head = await u.store.head(u.sid);
    await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' }));
    await u.send(host.conn, u.ctl('control.kick', { member: newId('mem'), code: 'other' }));
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['not_found', 'not_found']);
    expect(await u.store.head(u.sid)).toBe(head);
    expect((await u.epochs.current(u.sid)).kid).toBe('k2');
  });
});

describe('failure modes', () => {
  it('sequencer down for the pair: 503, the removal undone, the member may reconnect', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    u.failures.rotate = true;
    await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' }));
    expect(u.errorsOf(host.conn)).toEqual([
      expect.objectContaining({ code: 'service_unavailable', retry_after_s: 1 }),
    ]);
    // Closed before the pair, but still a member: a reconnect is admitted and may send.
    expect(target.conn.closedWith).toBe(4403);
    expect(u.db.left(u.sid, target.mid)).toBe(false);
    expect((await u.epochs.current(u.sid)).kid).toBe('k1');
    const back = u.member('editor', { mid: target.mid });
    expect(await u.send(back.conn, u.event())).toBeDefined();
    expect(u.events('control.kick').map((e) => e.outcome)).toEqual(['failed']);
  });

  it('sequencer down for the kick itself: B041’s 503, nothing applied', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const assign = u.store.assign.bind(u.store);
    u.store.assign = () => Promise.reject(new Error('redis down'));
    await u.send(host.conn, u.ctl('control.kick', { member: target.mid, code: 'other' }));
    u.store.assign = assign;
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['service_unavailable']);
    expect(target.conn.closedWith).toBeNull();
    expect(u.db.left(u.sid, target.mid)).toBe(false);
    expect(await u.store.head(u.sid)).toBe(0);
  });

  it('target already offline: still removed, member_left and rotate_key emitted, accepted', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const offline = u.member('editor', { connected: false });
    const kick = await u.send(
      host.conn,
      u.ctl('control.kick', { member: offline.mid, code: 'inactive' }),
    );
    expect(kick?.seq).toBe(1);
    kickPair(await u.sequenced(), offline.mid);
    expect(u.db.left(u.sid, offline.mid)).toBe(true);
    expect(u.errorsOf(host.conn)).toEqual([]);
  });

  it('a resend of the same kick has no second effect and echoes the original seq', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const frame = u.ctl('control.kick', { member: target.mid, code: 'other' });
    await u.send(host.conn, frame);
    const head = await u.store.head(u.sid);
    await u.send(host.conn, frame);
    expect(await u.store.head(u.sid)).toBe(head);
    expect((await u.epochs.current(u.sid)).kid).toBe('k2');
    const echoes = host.conn.frames().filter((f) => f['id'] === frame.id);
    expect(echoes.map((f) => f['seq'])).toEqual([1, 1]);
    expect(u.errorsOf(host.conn)).toEqual([]);
    expect(u.events('control.kick')).toHaveLength(1);
    expect(
      u.recorded.count('relay_control_frames_total', {
        kind: 'control.kick',
        outcome: 'duplicate',
      }),
    ).toBe(1);
  });
});

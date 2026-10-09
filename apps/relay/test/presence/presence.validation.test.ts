/**
 * Validation and identity (B047; tests "presence.validation.test.ts", acceptance 5 and 6,
 * guardrails "only status, activity and agent_count" and "online from the connection"):
 * `status: "busy2"` (or a bad activity or agent count) is `sys.error invalid_frame` with the field's
 * pointer and changes nothing; unknown fields of `p` are dropped; any role, a viewer included, may
 * send `presence.update`; a client's `from` is ignored and the connection's member is stamped.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { noMutes, authorizeFrame } from '../../src/rooms/kind-policy.js';
import { checkPresenceUpdate } from '../../src/presence/validate.js';
import { presenceUnit } from './helpers.js';

describe('invalid payloads (acceptance 5)', () => {
  it('busy2 is invalid_frame at /p/status and changes nothing', async () => {
    const u = presenceUnit();
    const sender = u.join();
    expect(
      await u.update(
        sender,
        { status: 'busy2', activity: 'idle' },
        { id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W' },
      ),
    ).toBe(true);
    const error = sender.frames().find((f) => f['t'] === 'sys.error');
    expect(error).toMatchObject({
      ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      p: { code: 'invalid_frame', errors: [{ pointer: '/p/status' }] },
    });
    expect(u.published).toEqual([]);
    expect(u.presence.snapshot(u.sid)).toEqual([]);
    expect((await u.store.read(u.sid)).size).toBe(0);
    expect(u.recorded.count('relay_presence_updates_total', { result: 'invalid' })).toBe(1);
  });

  it('checks every field', () => {
    for (const [p, pointer] of [
      [null, '/p'],
      [[], '/p'],
      [{ activity: 'idle' }, '/p/status'],
      [{ status: 'online', activity: 'sleeping' }, '/p/activity'],
      [{ status: 'online', activity: 'idle', agent_count: -1 }, '/p/agent_count'],
      [{ status: 'online', activity: 'idle', agent_count: 1.5 }, '/p/agent_count'],
      [{ status: 'online', activity: 'idle', agent_count: 1_001 }, '/p/agent_count'],
      [{ status: 'offline', activity: 'idle' }, '/p/status'],
    ] as const) {
      expect(checkPresenceUpdate(p), JSON.stringify(p)).toEqual({ ok: false, pointer });
    }
  });

  it('drops unknown fields of p: only status, activity and agent_count are kept', async () => {
    const u = presenceUnit();
    const sender = u.join();
    await u.update(sender, {
      status: 'away',
      activity: 'reviewing',
      agent_count: 2,
      secret: 'x',
      file: '/etc',
    });
    expect(u.published[0]?.frame['p']).toEqual({
      status: 'away',
      activity: 'reviewing',
      agent_count: 2,
    });
    const [entry] = (await u.store.read(u.sid)).values();
    expect(entry?.p).toEqual({ status: 'away', activity: 'reviewing', agent_count: 2 });
  });
});

describe('who may send, and as whom (acceptance 6)', () => {
  it('every role may send presence.update', () => {
    for (const role of ['host', 'editor', 'viewer'] as const) {
      expect(
        authorizeFrame(
          { id: newId('mem'), sid: newId('ses'), role },
          { t: 'presence', k: 'presence.update' },
          noMutes,
        ),
      ).toMatchObject({ ok: true });
    }
  });

  it('a viewer’s update goes out under its member id, whatever `from` it claims', async () => {
    const u = presenceUnit();
    const member = newId('mem');
    const viewer = u.join(member, u.sid, 'viewer');
    await u.update(viewer, { status: 'online', activity: 'idle' }, { from: newId('mem') });
    expect(u.published[0]?.frame['from']).toBe(member);
    expect(u.presence.snapshot(u.sid)).toEqual([
      { member, p: { status: 'online', activity: 'idle' } },
    ]);
  });

  it('other presence kinds (cursor, nudge) and other frames pass on', async () => {
    const u = presenceUnit();
    const conn = u.join();
    let passed = 0;
    for (const frame of [
      { v: 1, t: 'presence', k: 'presence.cursor', ct: {} },
      { v: 1, t: 'event', k: 'reaction', p: {} },
      'not a frame',
    ]) {
      await u.stage({ connection: conn, raw: '', frame, state: {} }, () => {
        passed += 1;
        return Promise.resolve();
      });
    }
    expect(passed).toBe(3);
  });

  it('an update before the welcome (no member yet) is ignored', async () => {
    const u = presenceUnit();
    const conn = u.join();
    conn.entry.memberId = null;
    expect(await u.update(conn, { status: 'online', activity: 'idle' })).toBe(true);
    expect(u.published).toEqual([]);
  });
});

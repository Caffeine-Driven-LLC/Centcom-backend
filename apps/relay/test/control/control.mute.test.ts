/**
 * Mutes (B051; tests "control.mute.test.ts", acceptance 4):
 *
 * - a muted member's `event` and `queue` frames are refused (`sys.error muted`, not sequenced) while
 *   its presence frames still pass;
 * - `until` elapsing (injected clock) and `control.unmute` let frames through again;
 * - a mute takes effect only once its frame has a `seq`;
 * - another node (another registry on the same store) sees a mute within the 2 s cache;
 * - the store failing: a session never read is refused 503 (fail closed), one read before keeps
 *   its mutes;
 * - `until` in the past is `invalid_frame`.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryMuteStore,
  createMuteRegistry,
  MUTE_CACHE_TTL_MS,
} from '../../src/control/mute-registry.js';
import { UNAVAILABLE_PAUSE_MS } from '../../src/seq/stage.js';
import { controlUnit } from './helpers.js';

const iso = (ms: number) => new Date(ms).toISOString();

describe('a muted member', () => {
  it('has event and queue frames refused with `muted`, while presence passes', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const m = u.member('editor');
    expect((await u.send(host.conn, u.ctl('control.mute', { member: m.mid })))?.seq).toBe(1);
    expect(await u.send(m.conn, u.event())).toBeUndefined();
    expect(await u.send(m.conn, u.queue())).toBeUndefined();
    expect(u.errorsOf(m.conn).map((p) => p['code'])).toEqual(['muted', 'muted']);
    expect(await u.store.head(u.sid)).toBe(1);
    await u.send(m.conn, u.presence());
    expect(u.last.reached).toBe(true);
    expect(u.errorsOf(m.conn)).toHaveLength(2);
    // Other members are not muted.
    const other = u.member('editor');
    expect((await u.send(other.conn, u.event()))?.seq).toBe(2);
    expect(u.muteStore.rows()).toEqual([{ member: m.mid, until: null }]);
  });

  it('sends again once `until` has passed (injected clock)', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const m = u.member('editor');
    const until = u.clock.now + 60_000;
    await u.send(host.conn, u.ctl('control.mute', { member: m.mid, until: iso(until) }));
    expect(await u.send(m.conn, u.event())).toBeUndefined();
    u.clock.now = until - 1;
    expect(await u.send(m.conn, u.event())).toBeUndefined();
    u.clock.now = until;
    expect((await u.send(m.conn, u.event()))?.seq).toBe(2);
    expect(u.events('control.mute')[0]?.meta).toEqual({ session_id: u.sid, until: iso(until) });
  });

  it('sends again after control.unmute', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const m = u.member('editor');
    await u.send(host.conn, u.ctl('control.mute', { member: m.mid }));
    expect(await u.send(m.conn, u.event())).toBeUndefined();
    await u.send(host.conn, u.ctl('control.unmute', { member: m.mid }));
    expect((await u.send(m.conn, u.event()))?.seq).toBe(3);
    expect(u.muteStore.rows()).toEqual([]);
  });

  it('is not muted before the mute frame has a seq', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const m = u.member('editor');
    const assign = u.store.assign.bind(u.store);
    u.store.assign = () => Promise.reject(new Error('redis down'));
    await u.send(host.conn, u.ctl('control.mute', { member: m.mid }));
    u.store.assign = assign;
    u.advance(UNAVAILABLE_PAUSE_MS);
    expect(u.muteStore.rows()).toEqual([]);
    expect((await u.send(m.conn, u.event()))?.seq).toBe(1);
  });

  it('refuses `until` in the past: invalid_frame at /p/until, nothing sequenced', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const m = u.member('editor');
    await u.send(host.conn, u.ctl('control.mute', { member: m.mid, until: iso(u.clock.now) }));
    const [error] = u.errorsOf(host.conn);
    expect(error).toMatchObject({ code: 'invalid_frame', errors: [{ pointer: '/p/until' }] });
    expect(await u.store.head(u.sid)).toBe(0);
  });
});

describe('the mute registry', () => {
  it('another node sees a mute within the 2 s cache', async () => {
    const store = createMemoryMuteStore();
    const clock = { now: 0 };
    const a = createMuteRegistry({ store, clock: () => clock.now });
    const b = createMuteRegistry({ store, clock: () => clock.now });
    await b.ready('ses_1');
    await a.mute('ses_1', 'mem_1', null);
    expect(a.isMuted('ses_1', 'mem_1')).toBe(true);
    expect(b.ready('ses_1')).toBeUndefined();
    expect(b.isMuted('ses_1', 'mem_1')).toBe(false);
    clock.now += MUTE_CACHE_TTL_MS;
    await b.ready('ses_1');
    expect(b.isMuted('ses_1', 'mem_1')).toBe(true);
  });

  it('shares one reload between concurrent frames', async () => {
    const store = createMemoryMuteStore();
    let lists = 0;
    const list = store.list.bind(store);
    store.list = (sid) => {
      lists += 1;
      return list(sid);
    };
    const r = createMuteRegistry({ store, clock: () => 0 });
    await Promise.all([r.ready('ses_1'), r.ready('ses_1'), r.ready('ses_1')]);
    expect(lists).toBe(1);
  });

  it('fails closed for a session never read, and keeps known mutes when a reload fails', async () => {
    const store = createMemoryMuteStore();
    const clock = { now: 0 };
    const r = createMuteRegistry({ store, clock: () => clock.now });
    await store.put('ses_1', 'mem_1', null);
    await r.ready('ses_1');
    store.failing = true;
    await expect(r.ready('ses_2')).rejects.toThrow();
    clock.now += MUTE_CACHE_TTL_MS;
    await r.ready('ses_1');
    expect(r.isMuted('ses_1', 'mem_1')).toBe(true);
  });

  it('a muted member’s frame on a session whose mutes cannot be read: 503', async () => {
    const u = controlUnit();
    const m = u.member('editor');
    u.muteStore.failing = true;
    expect(await u.send(m.conn, u.event())).toBeUndefined();
    expect(u.errorsOf(m.conn)).toEqual([
      expect.objectContaining({ code: 'service_unavailable', retry_after_s: 1 }),
    ]);
    // Presence does not depend on mutes.
    await u.send(m.conn, u.presence());
    expect(u.last.reached).toBe(true);
  });
});

/**
 * Stale and future kids (B049; tests "keys.stale-kid.test.ts", acceptance 5 and 6, guardrail
 * "enforcement based on the member's acked seq"; failure mode "epoch store unavailable"): after a
 * rotation to `k2`, a member's `k1` frame sent before it acked the rotation's `seq` is accepted (in
 * flight); once it acked it, a `k1` frame is `invalid_frame` and not sequenced. `k9` while current is
 * `k2` is refused. A kid that is not `k<n>` is refused. An epoch store that fails refuses encrypted
 * frames 503 (fail closed); clear frames pass.
 */
import { describe, expect, it } from 'vitest';
import type { EpochStore } from '../../src/keys/epoch-store.js';
import { createMemoryEpochStore } from '../../src/keys/epoch-store.js';
import { reactionFrame } from '../resume/helpers.js';
import { keysUnit } from './helpers.js';

describe('ack-based enforcement (acceptance 5)', () => {
  it('k1 in flight is accepted; after acking the rotation, k1 is refused', async () => {
    const u = keysUnit();
    const m = u.member('editor');
    await u.send(m.conn, u.encrypted('k1'));
    const { seq: rotation } = await u.epochs.rotate(u.sid, 'member_removed');
    expect(rotation).toBe(2);
    // Not acked yet: in flight.
    expect((await u.send(m.conn, u.encrypted('k1')))?.seq).toBe(3);
    await u.ack(m.conn, rotation);
    expect(await u.send(m.conn, u.encrypted('k1'))).toBeUndefined();
    expect(u.errorsOf(m.conn).at(-1)).toMatchObject({
      code: 'invalid_frame',
      errors: [{ pointer: '/ct/kid' }],
    });
    expect((await u.send(m.conn, u.encrypted('k2')))?.seq).toBe(4);
    expect(u.recorded.count('relay_kid_refused_total', { reason: 'stale' })).toBe(1);
  });

  it('another member who has not acked keeps sending k1', async () => {
    const u = keysUnit();
    const a = u.member('editor');
    const b = u.member('editor');
    const { seq } = await u.epochs.rotate(u.sid, 'requested');
    await u.ack(a.conn, seq);
    expect(await u.send(a.conn, u.encrypted('k1'))).toBeUndefined();
    expect((await u.send(b.conn, u.encrypted('k1')))?.seq).toBe(2);
  });
});

describe('future and malformed kids (acceptance 6)', () => {
  it('k9 while current is k2 is refused; so is a kid that is not k<n>', async () => {
    const u = keysUnit();
    const m = u.member('editor');
    await u.epochs.rotate(u.sid, 'requested');
    for (const kid of ['k9', 'k3', 'x1', 'k0', 7]) {
      expect(await u.send(m.conn, u.encrypted(kid as string)), String(kid)).toBeUndefined();
    }
    expect(u.recorded.count('relay_kid_refused_total', { reason: 'future' })).toBe(2);
    expect(u.recorded.count('relay_kid_refused_total', { reason: 'invalid' })).toBe(3);
    expect(await u.store.head(u.sid)).toBe(1);
  });

  it('re-reads the store before refusing: another node may have rotated', async () => {
    const store = createMemoryEpochStore();
    const u = keysUnit({ store });
    const m = u.member('editor');
    expect((await u.send(m.conn, u.encrypted('k1')))?.seq).toBe(1);
    // Another node rotates to k2 (this node's cache still says k1).
    await store.next(u.sid);
    await store.announce(u.sid, 2, 5, Date.now());
    expect((await u.send(m.conn, u.encrypted('k2')))?.seq).toBe(2);
  });
});

describe('fail closed', () => {
  it('an epoch store that fails refuses encrypted frames 503; clear frames pass', async () => {
    const failing: EpochStore = {
      read: () => Promise.reject(new Error('redis down')),
      next: () => Promise.reject(new Error('redis down')),
      announce: () => Promise.reject(new Error('redis down')),
    };
    const u = keysUnit({ store: failing });
    const m = u.member('editor');
    expect(await u.send(m.conn, u.encrypted('k1'))).toBeUndefined();
    expect(u.errorsOf(m.conn)[0]).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    expect((await u.send(m.conn, reactionFrame(u.sid)))?.seq).toBe(1);
    await expect(u.epochs.rotate(u.sid, 'requested')).rejects.toThrow('redis down');
  });
});

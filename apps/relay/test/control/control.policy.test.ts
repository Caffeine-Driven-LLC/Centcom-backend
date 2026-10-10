/**
 * Session policy (B051, acceptance 8 and the policy failure mode):
 *
 * - a payload failing the generated schema (`queue_limit` -1, an unknown `auto_approve`) is
 *   `invalid_frame` at the codec (B039), and again in the handler if it ever got that far;
 * - a valid policy is stored and visible to `PolicyStore.get` before the next frame is processed,
 *   with the frame's `seq`; optional fields left out keep their previous values;
 * - the store failing: `service_unavailable`, not sequenced, previous policy kept; sequencing
 *   failing: the written policy is put back.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../../src/codec/codec.js';
import { DEFAULT_POLICY, MAX_POLICY_MEMBERS, policyFrom } from '../../src/control/policy-store.js';
import { UNAVAILABLE_PAUSE_MS } from '../../src/seq/stage.js';
import { controlUnit } from './helpers.js';

const VALID = { auto_approve: 'trusted', share_history: true, queue_limit: 3 };

describe('an invalid policy', () => {
  it('is invalid_frame at the codec: queue_limit -1, an unknown auto_approve', () => {
    const sid = newId('ses');
    for (const p of [
      { ...VALID, queue_limit: -1 },
      { ...VALID, auto_approve: 'nobody' },
      { auto_approve: 'ask', share_history: true },
    ]) {
      const frame = { v: 1, t: 'control', id: newId('msg'), sid, k: 'control.policy', p };
      expect(decodeFrame(JSON.stringify(frame), false, sid)).toMatchObject({
        ok: false,
        code: 'invalid_frame',
      });
    }
  });

  it('is invalid_frame in the handler too, with the field’s pointer, and nothing stored', async () => {
    const u = controlUnit();
    const host = u.member('host');
    await u.send(host.conn, u.ctl('control.policy', { ...VALID, queue_limit: -1 }));
    await u.send(host.conn, u.ctl('control.policy', { ...VALID, auto_approve: 'nobody' }));
    const tooMany = Array.from({ length: MAX_POLICY_MEMBERS + 1 }, () => newId('mem'));
    await u.send(host.conn, u.ctl('control.policy', { ...VALID, trusted: tooMany }));
    const errors = u.errorsOf(host.conn);
    expect(errors.map((p) => p['code'])).toEqual([
      'invalid_frame',
      'invalid_frame',
      'invalid_frame',
    ]);
    expect(errors.map((p) => (p['errors'] as { pointer: string }[])[0]?.pointer)).toEqual([
      '/p/queue_limit',
      '/p/auto_approve',
      '/p/trusted',
    ]);
    expect(await u.store.head(u.sid)).toBe(0);
    expect(await u.policies.get(u.sid)).toEqual(DEFAULT_POLICY);
  });
});

describe('a valid policy', () => {
  it('is visible to PolicyStore.get before the next frame, with its seq', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const stored = await u.send(
      host.conn,
      u.ctl('control.policy', { ...VALID, queue_paused: true }),
    );
    expect(stored?.seq).toBe(1);
    expect(await u.policies.read(u.sid)).toEqual({
      policy: { ...DEFAULT_POLICY, ...VALID, queue_paused: true },
      updatedSeq: 1,
    });
    expect(u.events('control.policy')[0]?.meta).toEqual({
      session_id: u.sid,
      fields: 'auto_approve,queue_limit,queue_paused,share_history',
    });
  });

  it('keeps optional fields the frame leaves out', () => {
    const previous = {
      ...DEFAULT_POLICY,
      queue_paused: true,
      trusted: ['mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W'],
    };
    expect(policyFrom(VALID, previous)).toEqual({ ...previous, ...VALID });
    expect(policyFrom({ ...VALID, queue_paused: false }, previous)).toMatchObject({
      queue_paused: false,
    });
  });
});

describe('failures', () => {
  it('a store write failing: service_unavailable, not sequenced, previous policy kept', async () => {
    const u = controlUnit();
    const host = u.member('host');
    await u.send(host.conn, u.ctl('control.policy', VALID));
    u.policies.failing = true;
    await u.send(host.conn, u.ctl('control.policy', { ...VALID, queue_limit: 9 }));
    u.policies.failing = false;
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['service_unavailable']);
    expect(await u.store.head(u.sid)).toBe(1);
    expect((await u.policies.get(u.sid)).queue_limit).toBe(3);
  });

  it('sequencing failing: the policy written before it is put back', async () => {
    const u = controlUnit();
    const host = u.member('host');
    await u.send(host.conn, u.ctl('control.policy', VALID));
    const assign = u.store.assign.bind(u.store);
    u.store.assign = () => Promise.reject(new Error('redis down'));
    await u.send(host.conn, u.ctl('control.policy', { ...VALID, queue_limit: 9 }));
    u.store.assign = assign;
    u.advance(UNAVAILABLE_PAUSE_MS);
    expect(await u.policies.read(u.sid)).toEqual({
      policy: { ...DEFAULT_POLICY, ...VALID },
      updatedSeq: 1,
    });
    expect(u.events('control.policy').map((e) => e.outcome)).toEqual(['success', 'failed']);
  });
});

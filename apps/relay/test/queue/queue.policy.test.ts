/**
 * Queue policy (B052; tests "queue.policy.test.ts", acceptance 4, 7 and 10):
 *
 * - `everyone`: an editor's submit, then the relay's `queue.approve` (from `srv`, the policy as
 *   reason) at the next seq; `ask`: nothing; `trusted`: listed members only; the host's own items
 *   never;
 * - viewer and muted submits (B043), and any submit while `locked`: refused and audited;
 * - approvals paused (the quota hook, or the policy's `queue_paused`): approve and claim are
 *   `queue_not_allowed` and nothing is auto-approved, while submit, cancel and drop still work.
 */
import { describe, expect, it } from 'vitest';
import { queueUnit } from './helpers.js';

describe('auto-approval', () => {
  it('everyone: the relay approves an editor’s submit at the next seq, from srv', async () => {
    const u = queueUnit();
    await u.policy({ auto_approve: 'everyone' });
    const m = u.member('editor');
    const f = u.submit();
    const stored = await u.send(m.conn, f);
    const frames = await u.sequenced();
    expect(frames.slice(0, 2)).toEqual([
      expect.objectContaining({ seq: stored?.seq, k: 'queue.submit', from: m.mid }),
      expect.objectContaining({
        seq: (stored?.seq ?? 0) + 1,
        k: 'queue.approve',
        from: 'srv',
        p: { item: u.itemOf(f), reason: 'policy', policy: 'everyone' },
      }),
    ]);
    expect(u.service.snapshot(u.sid).items[0]).toMatchObject({ state: 'approved', position: 1 });
    expect(u.recorded.count('relay_queue_items_total', { state: 'approved' })).toBe(1);
  });

  it('ask: nothing is auto-approved', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    await u.send(m.conn, u.submit());
    expect((await u.sequenced()).map((f) => f.k)).toEqual(['queue.submit', 'queue.state']);
    expect(u.service.snapshot(u.sid).items[0]?.state).toBe('queued');
  });

  it('trusted: only members on the list', async () => {
    const u = queueUnit();
    const trusted = u.member('editor');
    const other = u.member('editor');
    await u.policy({ auto_approve: 'trusted', trusted: [trusted.mid] });
    await u.send(trusted.conn, u.submit());
    await u.send(other.conn, u.submit());
    const states = u.service.snapshot(u.sid).items.map((i) => [i.submitter, i.state]);
    expect(states).toEqual([
      [trusted.mid, 'approved'],
      [other.mid, 'queued'],
    ]);
    expect((await u.sequenced()).find((f) => f.k === 'queue.approve')).toMatchObject({
      p: { policy: 'trusted' },
    });
  });

  it('never the host’s own items', async () => {
    const u = queueUnit();
    await u.policy({ auto_approve: 'everyone' });
    const host = u.member('host');
    await u.send(host.conn, u.submit());
    expect(u.service.snapshot(u.sid).items[0]?.state).toBe('queued');
  });
});

describe('who may submit', () => {
  it('a viewer: forbidden and audited (B043)', async () => {
    const u = queueUnit();
    const v = u.member('viewer');
    expect(await u.send(v.conn, u.submit())).toBeUndefined();
    expect(u.errorsOf(v.conn).map((p) => p['code'])).toEqual(['forbidden']);
    expect(u.events('permission.denied')).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ attempted: 'queue.submit' }) }),
    ]);
  });

  it('a muted member: refused (`muted`) and audited', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    await u.mutes.mute(u.sid, m.mid, null);
    expect(await u.send(m.conn, u.submit())).toBeUndefined();
    expect(u.errorsOf(m.conn).map((p) => p['code'])).toEqual(['muted']);
    expect(u.events('permission.denied')).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'muted' }) }),
    ]);
  });

  it('anyone while the session is locked: forbidden and audited', async () => {
    const u = queueUnit();
    await u.policy({ locked: true });
    const host = u.member('host');
    const m = u.member('editor');
    for (const who of [host, m]) {
      expect(await u.send(who.conn, u.submit())).toBeUndefined();
      expect(u.errorsOf(who.conn).map((p) => p['code'])).toEqual(['forbidden']);
    }
    expect(u.events('permission.denied').map((e) => e.meta?.['reason'])).toEqual([
      'locked',
      'locked',
    ]);
    expect(await u.store.head(u.sid)).toBe(0);
  });

  it('host-only kinds from an editor: forbidden and audited (B043)', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    const f = u.submit();
    await u.send(m.conn, f);
    for (const kind of ['queue.approve', 'queue.drop', 'queue.claim']) {
      await u.send(
        m.conn,
        u.op(kind, { item: u.itemOf(f), agent_id: 'agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W' }),
      );
    }
    expect(u.errorsOf(m.conn).map((p) => p['code'])).toEqual([
      'forbidden',
      'forbidden',
      'forbidden',
    ]);
    expect(u.events('permission.denied')).toHaveLength(3);
  });

  it('cancel by someone other than the submitter: forbidden and audited', async () => {
    const u = queueUnit();
    const a = u.member('editor');
    const b = u.member('editor');
    const f = u.submit();
    await u.send(a.conn, f);
    await u.send(b.conn, u.op('queue.cancel', { item: u.itemOf(f) }));
    expect(u.errorsOf(b.conn).map((p) => p['code'])).toEqual(['forbidden']);
    expect(u.events('permission.denied')).toHaveLength(1);
  });
});

describe('paused approvals', () => {
  for (const how of ['the quota hook', 'the policy’s queue_paused'] as const) {
    it(`${how}: approve and claim refused, no auto-approval; submit, cancel and drop work`, async () => {
      const u = queueUnit();
      await u.policy({ auto_approve: 'everyone' });
      if (how === 'the quota hook') u.service.setApprovalsPaused(u.sid, true);
      else await u.policy({ queue_paused: true });
      const host = u.member('host');
      const m = u.member('editor');
      const [a, b, c] = [u.submit(), u.submit(), u.submit()];
      for (const f of [a, b, c]) expect(await u.send(m.conn, f)).toBeDefined();
      expect(u.service.snapshot(u.sid).items.every((i) => i.state === 'queued')).toBe(true);
      await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(a) }));
      expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['queue_not_allowed']);
      expect(await u.send(m.conn, u.op('queue.cancel', { item: u.itemOf(b) }))).toBeDefined();
      expect(await u.send(host.conn, u.op('queue.drop', { item: u.itemOf(c) }))).toBeDefined();
      expect(u.service.snapshot(u.sid).items.map((i) => i.state)).toEqual(['queued']);
      // Lifted: approvals work again.
      if (how === 'the quota hook') u.service.setApprovalsPaused(u.sid, false);
      else await u.policy({ queue_paused: false });
      expect(await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(a) }))).toBeDefined();
    });
  }
});

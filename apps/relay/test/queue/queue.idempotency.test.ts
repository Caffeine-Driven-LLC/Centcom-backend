/**
 * Idempotency and failures (B052; tests "queue.idempotency.test.ts", acceptance 1, 5 and 9, and
 * the failure modes):
 *
 * - the same `queue.submit` (same sid, from, id) 10 times: one item, one seq, the 9 repeats echo
 *   it; the same item under a new frame id: echoed too, nothing new;
 * - concurrent submits: every one stored, versions 1..n, one `queue.state` each;
 * - approve of an unknown or finished item: `queue_item_gone` to the host only, no `queue.state`;
 * - the version rises by exactly 1 per state-changing frame, never on a refused one;
 * - a store write failing: 503, nothing sequenced, the queue unchanged; the sequencer failing for
 *   submit + auto-approve: neither visible, and a retry with the same id is consistent.
 */
import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_PAUSE_MS } from '../../src/seq/stage.js';
import { queueUnit } from './helpers.js';

describe('resends', () => {
  it('the same submit 10 times: one item and one seq; the repeats echo it', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    const frame = u.submit();
    for (let i = 0; i < 10; i += 1) await u.send(m.conn, frame);
    const echoes = m.conn.frames().filter((f) => f['id'] === frame.id);
    expect(echoes.map((f) => f['seq'])).toEqual(Array.from({ length: 10 }, () => 1));
    expect((await u.sequenced()).filter((f) => f.k === 'queue.submit')).toHaveLength(1);
    expect(u.service.snapshot(u.sid).items).toHaveLength(1);
    expect(u.service.snapshot(u.sid).version).toBe(1);
    expect(u.errorsOf(m.conn)).toEqual([]);
  });

  it('the same item under a new frame id: the original seq is echoed, nothing new', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    const first = u.submit();
    await u.send(m.conn, first);
    const again = u.submit({ item: u.itemOf(first) });
    expect(await u.send(m.conn, again)).toBeUndefined();
    expect(
      m.conn
        .frames()
        .filter((f) => f['k'] === 'queue.submit')
        .map((f) => f['seq']),
    ).toEqual([1, 1]);
    expect(u.service.snapshot(u.sid).version).toBe(1);
    expect(u.errorsOf(m.conn)).toEqual([]);
  });

  it('concurrent submits: all stored, versions one apart, in seq order', async () => {
    const u = queueUnit();
    const members = Array.from({ length: 4 }, () => u.member('editor'));
    await Promise.all(
      members.flatMap((m) => [u.send(m.conn, u.submit()), u.send(m.conn, u.submit())]),
    );
    const states = (await u.sequenced()).filter((f) => f.k === 'queue.state');
    expect(states.map((f) => (f as unknown as { p: { version: number } }).p.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(u.service.snapshot(u.sid).items).toHaveLength(8);
  });
});

describe('refusals', () => {
  it('approve of an unknown or finished item: queue_item_gone to the host only, no queue.state', async () => {
    const u = queueUnit();
    const host = u.member('host');
    const m = u.member('editor');
    const f = u.submit();
    await u.send(m.conn, f);
    await u.send(host.conn, u.op('queue.reject', { item: u.itemOf(f), code: 'duplicate' }));
    const before = (await u.sequenced()).length;
    await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(f) }));
    await u.send(host.conn, u.op('queue.approve', { item: u.submit().p.item }));
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual([
      'queue_item_gone',
      'queue_item_gone',
    ]);
    expect(u.errorsOf(m.conn)).toEqual([]);
    expect((await u.sequenced()).length).toBe(before);
  });

  it('the version rises by exactly 1 per state-changing frame, never on a refused one', async () => {
    const u = queueUnit();
    const host = u.member('host');
    const m = u.member('editor');
    const f = u.submit();
    await u.send(m.conn, f);
    await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(f) }));
    await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(f) }));
    await u.send(host.conn, u.op('queue.reject', { item: u.itemOf(f), code: 'other' }));
    await u.send(m.conn, u.op('queue.cancel', { item: u.itemOf(f) }));
    const versions = (await u.sequenced())
      .filter((x) => x.k === 'queue.state')
      .map((x) => (x as unknown as { p: { version: number } }).p.version);
    expect(versions).toEqual([1, 2, 3]);
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['conflict', 'conflict']);
  });
});

describe('failures', () => {
  it('a store write failing: 503, nothing sequenced, the queue unchanged', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    await u.send(m.conn, u.submit());
    u.queueStore.failing = true;
    expect(await u.send(m.conn, u.submit())).toBeUndefined();
    u.queueStore.failing = false;
    expect(u.errorsOf(m.conn)).toEqual([
      expect.objectContaining({ code: 'service_unavailable', retry_after_s: 1 }),
    ]);
    expect(u.service.snapshot(u.sid).version).toBe(1);
    expect(u.queueStore.rows(u.sid)?.version).toBe(1);
    expect((await u.sequenced()).filter((f) => f.k === 'queue.submit')).toHaveLength(1);
  });

  it('the sequencer failing for submit + auto-approve: neither visible; a retry is consistent', async () => {
    const u = queueUnit();
    await u.policy({ auto_approve: 'everyone' });
    const m = u.member('editor');
    const frame = u.submit();
    const assignBatch = u.store.assignBatch.bind(u.store);
    u.store.assignBatch = () => Promise.reject(new Error('redis down'));
    expect(await u.send(m.conn, frame)).toBeUndefined();
    u.store.assignBatch = assignBatch;
    u.advance(UNAVAILABLE_PAUSE_MS);
    expect(await u.store.head(u.sid)).toBe(0);
    expect(u.service.snapshot(u.sid).items).toEqual([]);
    expect(u.queueStore.rows(u.sid)).toBeUndefined();
    // The retry, same frame: both go out, consecutive.
    const stored = await u.send(m.conn, frame);
    expect(stored?.seq).toBe(1);
    const frames = await u.sequenced();
    expect(frames.slice(0, 2).map((f) => [f.seq, f.k, f.from])).toEqual([
      [1, 'queue.submit', m.mid],
      [2, 'queue.approve', 'srv'],
    ]);
    expect(u.service.snapshot(u.sid).items[0]?.state).toBe('approved');
  });
});

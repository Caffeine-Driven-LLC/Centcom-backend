/**
 * Queue caps (B052; tests "queue.caps.test.ts", acceptance 2 and 3): 5 live items per member,
 * `queue_limit` (default 20) live items per session, `queue_full` past either, room again after a
 * cancel; a submit's `p.size` at most 192 KiB (196 608 passes, 196 609 is `invalid_frame` and never
 * stored).
 */
import { describe, expect, it } from 'vitest';
import { queueUnit } from './helpers.js';

describe('per-member and per-session caps', () => {
  it('a 6th live item from one member is queue_full; after a cancel it fits', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    const frames = Array.from({ length: 5 }, () => u.submit());
    for (const f of frames) expect(await u.send(m.conn, f)).toBeDefined();
    expect(await u.send(m.conn, u.submit())).toBeUndefined();
    expect(u.errorsOf(m.conn).map((p) => p['code'])).toEqual(['queue_full']);
    const first = frames[0];
    if (first === undefined) return;
    await u.send(m.conn, u.op('queue.cancel', { item: u.itemOf(first) }));
    expect(await u.send(m.conn, u.submit())).toBeDefined();
    expect(u.recorded.count('relay_queue_rejections_total', { code: 'queue_full' })).toBe(1);
  });

  it('with queue_limit 20 the 21st live item from anyone is queue_full', async () => {
    const u = queueUnit();
    const members = Array.from({ length: 5 }, () => u.member('editor'));
    for (const m of members.slice(0, 4)) {
      for (let i = 0; i < 5; i += 1) expect(await u.send(m.conn, u.submit())).toBeDefined();
    }
    const fifth = members[4];
    if (fifth === undefined) return;
    expect(await u.send(fifth.conn, u.submit())).toBeUndefined();
    expect(u.errorsOf(fifth.conn).map((p) => p['code'])).toEqual(['queue_full']);
    expect(u.service.snapshot(u.sid).items).toHaveLength(20);
  });

  it('follows the policy’s queue_limit', async () => {
    const u = queueUnit();
    await u.policy({ queue_limit: 2 });
    const m = u.member('editor');
    await u.send(m.conn, u.submit());
    await u.send(m.conn, u.submit());
    expect(await u.send(m.conn, u.submit())).toBeUndefined();
    expect(u.errorsOf(m.conn).map((p) => p['code'])).toEqual(['queue_full']);
  });

  it('finished items do not count', async () => {
    const u = queueUnit();
    const host = u.member('host');
    const m = u.member('editor');
    for (let i = 0; i < 5; i += 1) {
      const f = u.submit();
      await u.send(m.conn, f);
      await u.send(host.conn, u.op('queue.reject', { item: u.itemOf(f), code: 'not_now' }));
    }
    expect(await u.send(m.conn, u.submit())).toBeDefined();
  });
});

describe('the size cap', () => {
  it('196 608 bytes pass; 196 609 is invalid_frame at /p/size and never stored', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    expect(await u.send(m.conn, u.submit({ size: 196_608 }))).toBeDefined();
    const big = u.submit({ size: 196_609 });
    expect(await u.send(m.conn, big)).toBeUndefined();
    expect(u.errorsOf(m.conn)).toEqual([
      expect.objectContaining({
        code: 'invalid_frame',
        errors: [expect.objectContaining({ pointer: '/p/size' })],
      }),
    ]);
    expect(u.service.snapshot(u.sid).items.map((i) => i.item)).not.toContain(u.itemOf(big));
    expect(u.queueStore.rows(u.sid)?.items.map((i) => i.item)).not.toContain(u.itemOf(big));
  });
});

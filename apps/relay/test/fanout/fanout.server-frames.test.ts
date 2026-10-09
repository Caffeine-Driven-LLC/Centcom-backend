/**
 * Server frames (B044; tests "fanout.server-frames.test.ts", acceptance 3): a server-emitted
 * `control.member_joined` from `emitServer` takes the next `seq` of the session's space, is
 * delivered in order relative to client frames, carries `from: "srv"` (CT-WS-SESSION-EVENTS
 * "Server identity"; never a member id), is kept in the hot buffer and handed to the durable
 * append.
 */
import { describe, expect, it } from 'vitest';
import type { StoredFrame } from '../../src/seq/types.js';
import { fanoutUnit, newId, reactionFrame, type TextConnection } from './helpers.js';

describe('emitServer', () => {
  it('shares the seq space and order with client frames (acceptance 3)', async () => {
    const appended: StoredFrame[] = [];
    const u = fanoutUnit({
      durable: { append: (_sid, f) => (appended.push(f), Promise.resolve()) },
    });
    const [a, b] = [u.join(), u.join()] as [TextConnection, TextConnection];
    await u.send(a, reactionFrame(u.sid));
    const joined = await u.fanout.emitServer(u.sid, 'control.member_joined', 'control', {
      member: b.entry.memberId,
      name: 'Bo',
      slot: 1,
      role: 'editor',
      device: newId('dev'),
    });
    await u.send(b, reactionFrame(u.sid));
    expect(joined).toMatchObject({
      seq: 2,
      from: 'srv',
      t: 'control',
      k: 'control.member_joined',
      sid: u.sid,
    });
    for (const conn of [a, b]) {
      expect(conn.seqs()).toEqual([1, 2, 3]);
      expect(conn.frames()[1]).toEqual(joined);
    }
    expect((await u.store.range(u.sid, 1, 1))[0]).toEqual(joined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(appended.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(await u.store.head(u.sid)).toBe(3);
  });

  it('rejects when the store fails, delivering nothing', async () => {
    const u = fanoutUnit();
    const a = u.join();
    u.store.assign = () => Promise.reject(new Error('redis down'));
    await expect(
      u.fanout.emitServer(u.sid, 'queue.state', 'queue', { version: 1, items: [] }),
    ).rejects.toThrow('redis down');
    expect(a.texts).toEqual([]);
  });
});

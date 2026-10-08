/**
 * Sequencing (B011 acceptance 2): the session-wide `seq` both clients see, sends resolved by their
 * echoes, each frame type sent with the right shape, and presence staying unsequenced.
 */
import { describe, expect, it } from 'vitest';
import {
  connect,
  member,
  newId,
  reaction,
  seqs,
  sendReactions,
  startRelay,
  upTo,
  useCleanup,
} from './helpers.js';

useCleanup();

describe('sequencing', () => {
  it('gives two clients sending 200 frames the same strictly increasing seq 1..200, no gaps (acceptance 2)', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const a = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const b = await connect(relay, member(sid), { lastSeq: 0 });
    const results = (await Promise.all([sendReactions(a, 100), sendReactions(b, 100)])).flat();
    await Promise.all([
      a.waitFor((frame) => frame.seq === 200),
      b.waitFor((frame) => frame.seq === 200),
    ]);

    for (const client of [a, b]) {
      expect(seqs(client.frames)).toEqual(upTo(200));
      expect(client.lastSeq).toBe(200);
      expect(client.unackedIds).toEqual([]);
    }
    // Every send learned its seq from its echo: 200 distinct values.
    expect(results.map((result) => result.seq).sort((x, y) => x - y)).toEqual(upTo(200));
    // The relay stamped the sender, and the frames are the ones sent.
    const own = new Set(results.slice(0, 100).map((result) => result.id));
    expect(
      b.frames
        .filter((frame) => own.has(frame.id ?? ''))
        .every((frame) => frame.from === a.memberId),
    ).toBe(true);
  });

  it('sends every frame type with its shape: queue and control sequenced, ct for encrypted kinds, presence unsequenced', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const host = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const other = await connect(relay, member(sid), { lastSeq: 0 });

    const queue = await host.send('queue.approve', { item: newId('que') });
    const control = await host.send('control.kick', {
      member: other.memberId ?? '',
      code: 'other',
    });
    const message = await host.send('message.user');
    expect([queue.seq, control.seq, message.seq]).toEqual([1, 2, 3]);

    const frames = await Promise.all(
      [queue, control, message].map((sent) => other.waitFor((frame) => frame.id === sent.id)),
    );
    expect(frames.map((frame) => frame.t)).toEqual(['queue', 'control', 'event']);
    const [, , encrypted] = frames;
    expect(encrypted).not.toHaveProperty('p');
    expect(encrypted?.ct).toMatchObject({ alg: 'xchacha20poly1305', kid: 'k1' });
    expect(encrypted?.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);

    const presence = await host.send('presence.update', { status: 'online', activity: 'typing' });
    expect(presence.seq).toBe(0);
    const seen = await other.waitFor((frame) => frame.t === 'presence');
    expect(seen).toMatchObject({ k: 'presence.update', from: host.memberId });
    expect(seen.seq).toBeUndefined();
    expect(other.lastSeq).toBe(3);
  });

  it('carries opaque random ciphertext, different every time and never derived from the payload', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const host = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const first = await host.send('approval.decision', {
      approval_id: newId('apr'),
      decision: 'approve',
      scope: 'once',
    });
    const second = await host.send('approval.decision', {
      approval_id: newId('apr'),
      decision: 'approve',
      scope: 'once',
    });
    const [a, b] = [first, second].map((sent) => host.frames.find((frame) => frame.id === sent.id));
    expect(a?.p).toMatchObject({ decision: 'approve' });
    expect(a?.ct?.c).not.toBe(b?.ct?.c);
    expect(a?.ct?.n).not.toBe(b?.ct?.n);
    expect(reaction()).not.toEqual(reaction());
  });
});

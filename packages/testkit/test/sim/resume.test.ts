/**
 * Resume (B011 acceptance 3, CT-RESUME): after a cut connection the client resumes from its
 * highest contiguous seq, resends unacked frames with their ids, and the loopback keeps one copy;
 * replay with `sys.resumed`, history gaps, a gap filled by resuming, and `autoReconnect`.
 */
import { describe, expect, it } from 'vitest';
import { faults, type Fault } from '../../src/sim/index.js';
import {
  connect,
  member,
  newId,
  seqs,
  sendReactions,
  startRelay,
  upTo,
  useCleanup,
} from './helpers.js';

useCleanup();

describe('resume', () => {
  it('after disconnectAfter(50, 1006) and reconnect(), sends last_seq and resends unacked frames once (acceptance 3)', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const who = member(sid);
    const client = await connect(relay, who, {
      lastSeq: 0,
      faults: [faults.disconnectAfter(50, 1006)],
    });

    // Inbound so far: welcome, sys.resumed. Then 40 frames from the writer: 42.
    await sendReactions(writer, 40);
    await client.waitFor((frame) => frame.seq === 40);
    // Ten sends: their echoes are seq 41-50, and the cut comes after inbound frame 50 (seq 48).
    const sends = Array.from({ length: 10 }, () =>
      client.send('reaction', { target: newId('msg'), code: 'eyes', op: 'add' }),
    );
    expect((await client.waitForClose()).code).toBe(1006);
    const before = client.lastSeq;
    const unacked = client.unackedIds;
    expect(before).toBe(48);
    expect(unacked).toHaveLength(2);

    await client.reconnect();
    const hello = client.sent.findLast((frame) => frame.t === 'sys.hello');
    expect(hello?.p?.['last_seq']).toBe(before);
    // After the hello: the unacked frames again, with their ids.
    const resent = client.sent
      .slice(hello === undefined ? 0 : client.sent.lastIndexOf(hello))
      .filter((frame) => frame.t === 'event');
    expect(resent.map((frame) => frame.id)).toEqual(unacked);

    const results = await Promise.all(sends);
    expect(results.map((result) => result.seq)).toEqual(upTo(10).map((i) => 40 + i));
    // One copy each in the session; the resends were the duplicates.
    const mine = relay.log(sid).filter((frame) => frame.from === who.mid);
    expect(mine.map((frame) => frame.id)).toEqual(results.map((result) => result.id));
    // The replay answers the hello, so the resends can reach the relay after the client has its echoes.
    await expect.poll(() => relay.duplicates).toBe(unacked.length);
    expect(client.lastSeq).toBe(50);
    expect(seqs(client.frames)).toEqual(upTo(50));
    expect(client.unackedIds).toEqual([]);
  });

  it('replays what a resuming client missed, then reports it in sys.resumed', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    await sendReactions(writer, 5);
    const late = await connect(relay, member(sid), { lastSeq: 2 });
    const resumed = await late.waitFor((frame) => frame.t === 'sys.resumed');
    expect(resumed.p).toEqual({ from_seq: 3, to_seq: 5, count: 3 });
    expect(seqs(late.frames)).toEqual([3, 4, 5]);
    expect(late.welcome?.resume).toEqual({ from_seq: 3 });

    const fresh = await connect(relay, member(sid), { lastSeq: 5 });
    expect((await fresh.waitFor((frame) => frame.t === 'sys.resumed')).p).toEqual({
      from_seq: 6,
      to_seq: 5,
      count: 0,
    });
  });

  it('flags history_gap when the replay buffer no longer reaches back', async () => {
    const relay = await startRelay({ replayFrames: 3 });
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    await sendReactions(writer, 6);
    const late = await connect(relay, member(sid), { lastSeq: 1 });
    expect((await late.waitFor((frame) => frame.t === 'sys.resumed')).p).toEqual({
      from_seq: 4,
      to_seq: 6,
      count: 3,
      history_gap: true,
    });
  });

  it('holds frames behind a lost one until a resume fills the gap', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    let lost = false;
    const loseSeq3: Fault = (data, next) => {
      if (!lost && (JSON.parse(data) as { seq?: number }).seq === 3) lost = true;
      else next(data);
    };
    const client = await connect(relay, member(sid), { lastSeq: 0, faults: [loseSeq3] });
    await sendReactions(writer, 6);
    await expect.poll(() => client.wire.filter((frame) => frame.seq === 6).length).toBe(1);
    expect(seqs(client.frames)).toEqual([1, 2]);
    expect(client.lastSeq).toBe(2);

    await client.reconnect();
    await client.waitFor((frame) => frame.seq === 6);
    expect(seqs(client.frames)).toEqual(upTo(6));
    expect(client.sent.findLast((frame) => frame.t === 'sys.hello')?.p?.['last_seq']).toBe(2);
  });

  it('reconnects by itself with autoReconnect after a non-terminal close, resuming where it was', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const client = await connect(relay, member(sid), {
      lastSeq: 0,
      autoReconnect: true,
      random: () => 0,
    });
    await sendReactions(writer, 3);
    await client.waitFor((frame) => frame.seq === 3);
    const rewelcome = client.waitForNext((frame) => frame.t === 'sys.welcome');
    client.terminate();
    await rewelcome;
    expect(client.isOpen).toBe(true);
    expect(
      client.sent.filter((frame) => frame.t === 'sys.hello').map((frame) => frame.p?.['last_seq']),
    ).toEqual([0, 3]);
    await sendReactions(writer, 1);
    await client.waitFor((frame) => frame.seq === 4);
  });
});

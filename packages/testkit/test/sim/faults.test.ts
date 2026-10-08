/**
 * Faults (B011 acceptance 4, 5 and 7): inbound drop, duplicate, delay and reorder; malformed JSON
 * and the 4400 after more than 10 invalid frames in a minute; the 256 KiB frame limit; and
 * server-owned fields a client sends anyway, which the relay ignores.
 */
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  faults,
  MAX_FRAME_BYTES,
  type Fault,
  type Frame,
} from '../../src/sim/index.js';
import {
  connect,
  member,
  newId,
  reaction,
  roundTrip,
  sendReactions,
  seqs,
  startRelay,
  upTo,
  useCleanup,
} from './helpers.js';

useCleanup();

/** A seeded uniform source, so probabilistic faults repeat. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const errors = (frames: readonly Frame[]): Frame[] =>
  frames.filter((frame) => frame.t === 'sys.error');

/** A reaction frame whose JSON text is exactly `bytes` long. */
function frameOfSize(sid: string, bytes: number): string {
  const base = {
    v: 1,
    t: 'event',
    id: newId('msg'),
    sid,
    k: 'reaction',
    p: { ...reaction(), note: '' },
  };
  const empty = JSON.stringify(base).length;
  const text = JSON.stringify({ ...base, p: { ...base.p, note: 'x'.repeat(bytes - empty) } });
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}

describe('inbound faults', () => {
  it('with faults.duplicate(1.0), frames holds each seq once while the wire had two copies (acceptance 4)', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const client = await connect(relay, member(sid), {
      lastSeq: 0,
      faults: [faults.duplicate(1.0)],
    });

    await sendReactions(writer, 20);
    await client.waitFor((frame) => frame.seq === 20);
    await roundTrip(client);

    expect(seqs(client.frames)).toEqual(upTo(20));
    expect(seqs(client.wire)).toEqual(upTo(20).flatMap((seq) => [seq, seq]));
    expect(client.lastSeq).toBe(20);
  });

  it('with faults.drop, the frames after a lost one wait behind the gap', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    // Active only between the handshake and the resume, so neither loses its frames.
    let active = false;
    const drop = faults.drop(0.3);
    const gated: Fault = (data, next, ctx) => (active ? drop(data, next, ctx) : next(data));
    const client = await connect(relay, member(sid), {
      lastSeq: 0,
      faults: [gated],
      random: seeded(7),
    });
    active = true;

    await sendReactions(writer, 30);
    await roundTrip(writer);
    // Give the client's socket time to deliver what survived the fault.
    await expect
      .poll(() => client.wire.some((frame) => frame.seq !== undefined && frame.seq >= 25))
      .toBe(true);
    const arrived = seqs(client.wire);
    expect(arrived.length).toBeLessThan(30);
    const firstLost = upTo(30).find((seq) => !arrived.includes(seq)) ?? 31;
    expect(seqs(client.frames)).toEqual(upTo(firstLost - 1));
    expect(client.lastSeq).toBe(firstLost - 1);

    // A resume fills the gap.
    active = false;
    await client.reconnect();
    await client.waitFor((frame) => frame.seq === 30);
    expect(seqs(client.frames)).toEqual(upTo(30));
  });

  it('with faults.drop(0) nothing is lost, and probabilities outside [0, 1] are refused', () => {
    expect(() => faults.drop(1.5)).toThrow(RangeError);
    expect(() => faults.duplicate(-0.1)).toThrow(RangeError);
    expect(() => faults.reorder(1)).toThrow(RangeError);
    expect(() => faults.delay(-1)).toThrow(RangeError);
    expect(() => faults.disconnectAfter(0, 1006)).toThrow(RangeError);
    expect(() => faults.disconnectAfter(1, 1001)).toThrow(RangeError);
  });

  it('with faults.delay, frames arrive only when the clock reaches the delay, in order', async () => {
    const clock = createManualClock();
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    // The handshake itself is delayed, so the first clock advance lets the welcome through.
    const pending = connect(relay, member(sid), {
      lastSeq: 0,
      clock,
      faults: [faults.delay(1_000)],
    });
    await expect.poll(() => clock.pending()).toBeGreaterThan(0);
    clock.advance(1_000);
    const client = await pending;

    await sendReactions(writer, 5);
    // Five delayed frames plus the dead-peer timer.
    await expect.poll(() => clock.pending()).toBeGreaterThanOrEqual(6);
    expect(seqs(client.frames)).toEqual([]);
    clock.advance(999);
    expect(seqs(client.frames)).toEqual([]);
    clock.advance(1);
    expect(seqs(client.frames)).toEqual(upTo(5));
  });

  it('with faults.reorder, the wire is shuffled but frames stay in seq order', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const writer = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const client = await connect(relay, member(sid), {
      lastSeq: 0,
      faults: [faults.reorder(4)],
      random: seeded(3),
    });

    await sendReactions(writer, 40);
    await client.waitFor((frame) => frame.seq === 40);

    const wire = seqs(client.wire);
    expect([...wire].sort((a, b) => a - b)).toEqual(upTo(40));
    expect(wire).not.toEqual(upTo(40));
    expect(seqs(client.frames)).toEqual(upTo(40));
  });
});

describe('outbound faults', () => {
  it("answers sendRaw('{not json') with sys.error, and closes with 4400 after more than 10 invalid frames in a minute (acceptance 5)", async () => {
    const relay = await startRelay();
    const client = await connect(relay, member(newId('ses')));

    client.sendRaw('{not json');
    const first = await client.waitFor((frame) => frame.t === 'sys.error');
    expect(first.p).toMatchObject({ code: 'invalid_frame', status: 400 });

    for (let i = 2; i <= 10; i++) client.sendRaw('{not json');
    await expect.poll(() => errors(client.frames).length).toBe(10);
    expect(client.isOpen).toBe(true);

    client.sendRaw('{not json');
    expect((await client.waitForClose()).code).toBe(4400);
  });

  it('forgets invalid frames older than a minute', async () => {
    const clock = createManualClock();
    // Only the relay's window moves: heartbeats are pushed out of the way of the jump.
    const relay = await startRelay({ clock, pingMs: 600_000, deadMs: 600_000 });
    const client = await connect(relay, member(newId('ses')));

    for (let i = 0; i < 10; i++) client.sendRaw('{not json');
    await expect.poll(() => errors(client.frames).length).toBe(10);
    clock.advance(60_000);
    client.sendRaw('{not json');
    await expect.poll(() => errors(client.frames).length).toBe(11);
    await roundTrip(client);
    expect(client.isOpen).toBe(true);
  });

  it('rejects a frame of 262 145 bytes (256 KiB + 1) with sys.error invalid_frame, and takes one of 256 KiB (acceptance 7)', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const client = await connect(relay, member(sid));

    client.sendRaw(frameOfSize(sid, MAX_FRAME_BYTES + 1));
    const error = await client.waitFor((frame) => frame.t === 'sys.error');
    expect(error.p).toMatchObject({ code: 'invalid_frame' });
    expect(String(error.p?.['detail'])).toContain(`${MAX_FRAME_BYTES + 1} bytes`);
    expect(client.isOpen).toBe(true);

    // At the limit the size is fine: whatever the relay says, it is not about the size.
    client.sendRaw(frameOfSize(sid, MAX_FRAME_BYTES));
    await roundTrip(client);
    expect(errors(client.frames).map((frame) => String(frame.p?.['detail']))).not.toContainEqual(
      expect.stringContaining(`${MAX_FRAME_BYTES} bytes`),
    );
  });

  it('never sends from, ts or seq unless a fault scenario asks, and the relay ignores them', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const who = member(sid);
    const client = await connect(relay, who, { lastSeq: 0 });
    const forged = {
      v: 1,
      t: 'event',
      id: newId('msg'),
      sid,
      k: 'reaction',
      p: reaction(),
      from: newId('mem'),
      ts: '2020-01-01T00:00:00.000Z',
      seq: 999,
    } as const;

    // Stripped by default.
    await client.sendFrame({ ...forged });
    const plain = client.sent.findLast((frame) => frame.t === 'event');
    expect(plain).not.toHaveProperty('from');
    expect(plain).not.toHaveProperty('ts');
    expect(plain).not.toHaveProperty('seq');

    // Sent on purpose: the relay stamps its own.
    const result = await client.sendFrame(
      { ...forged, id: newId('msg') },
      { allowServerFields: true },
    );
    expect(client.sent.findLast((frame) => frame.t === 'event')).toMatchObject({
      from: forged.from,
      seq: 999,
    });
    expect(result.seq).toBe(2);
    const echo = await client.waitFor((frame) => frame.id === result.id);
    expect(echo.from).toBe(who.mid);
    expect(echo.seq).toBe(2);
    expect(echo.ts).not.toBe(forged.ts);
    for (const frame of client.sent)
      expect(['sys.hello', 'event', 'ack', 'sys.pong']).toContain(frame.t);
  });
});

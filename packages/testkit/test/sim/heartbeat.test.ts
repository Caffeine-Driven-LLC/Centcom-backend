/**
 * Heartbeat and ack cadence on a fake clock (B011): pings answered with the same `t`, pongs keeping
 * a connection alive past dead_ms, a silent peer dropped by either side, and acks after 64 frames
 * and within 5 s.
 */
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/sim/index.js';
import { connect, member, newId, sendReactions, startRelay, useCleanup } from './helpers.js';

useCleanup();

describe('heartbeat', () => {
  it('answers each sys.ping with a sys.pong of the same t, and the pongs keep it alive past dead_ms', async () => {
    const clock = createManualClock();
    const relay = await startRelay({ clock });
    const client = await connect(relay, member(newId('ses')), { clock });
    for (let i = 0; i < 3; i++) {
      clock.advance(20_000);
      const at = clock.now();
      await client.waitFor((frame) => frame.t === 'sys.ping' && frame.p?.['t'] === at);
      await relay.waitFor((frame) => frame.t === 'sys.pong' && frame.p?.['t'] === at);
    }
    // 60 s on the clock, more than dead_ms (50 s): both sides still see a live peer.
    expect(client.isOpen).toBe(true);
    expect(relay.connections).toBe(1);
  });

  it('lets the relay drop a stalled client after dead_ms', async () => {
    const clock = createManualClock();
    const relay = await startRelay({ clock });
    // The client's own clock stands still, so only the relay can give up on the connection.
    const client = await connect(relay, member(newId('ses')), { clock: createManualClock() });
    client.stall();
    clock.advance(49_999);
    expect(relay.connections).toBe(1);
    clock.advance(1);
    await expect.poll(() => relay.connections).toBe(0);
    client.unstall();
    expect((await client.waitForClose()).code).toBe(1006);
  });

  it('drops a relay that has been silent for dead_ms', async () => {
    const relay = await startRelay({ clock: createManualClock() }); // never advanced: it never pings
    const clientClock = createManualClock();
    const client = await connect(relay, member(newId('ses')), { clock: clientClock });
    clientClock.advance(49_999);
    expect(client.isOpen).toBe(true);
    clientClock.advance(1);
    expect((await client.waitForClose()).code).toBe(1006);
    await expect.poll(() => relay.connections).toBe(0);
  });
});

describe('ack cadence', () => {
  it('acks after every 64 frames and within 5 s of an unacked frame, with the highest contiguous seq', async () => {
    const clock = createManualClock();
    const relay = await startRelay({ clock });
    const sid = newId('ses');
    const reader = await connect(relay, member(sid), { clock, lastSeq: 0 });
    const writer = await connect(relay, member(sid, 'host'), { clock, lastSeq: 0 });
    const acks = (): (number | undefined)[] =>
      reader.sent.filter((frame) => frame.t === 'ack').map((frame) => frame.ack);

    await sendReactions(writer, 70);
    await reader.waitFor((frame) => frame.seq === 70);
    expect(acks()).toEqual([64]);
    expect(reader.sent.find((frame) => frame.t === 'ack')).toEqual({
      v: 1,
      t: 'ack',
      sid,
      ack: 64,
    });

    clock.advance(4_999);
    expect(acks()).toEqual([64]);
    clock.advance(1);
    expect(acks()).toEqual([64, 70]);
    await relay.waitFor((frame) => frame.t === 'ack' && frame.ack === 70);

    // Nothing new to ack: no more acks.
    clock.advance(10_000);
    expect(acks()).toEqual([64, 70]);

    reader.ack();
    expect(acks()).toEqual([64, 70, 70]);
  });
});

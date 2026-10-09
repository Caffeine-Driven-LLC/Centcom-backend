/**
 * Replay backpressure (B042; tests "resume.backpressure.test.ts", acceptance 5, guardrail "Replay
 * MUST honour outbound buffer limits"): replaying 5 000 frames of about 1.3 KB (6.5 MB) to a client
 * that drains 64 KiB per turn never lets its outbound buffer pass 2 MiB, delivers every frame in
 * order and takes under 2 s; a client that reads nothing is closed 4429 (`slow_consumer`) after
 * the stall limit, and the replay stops; the held live frames are bound by the same limit.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { WELCOME_LIMITS } from '../../src/handshake/handshake.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { recordingMetrics } from '../helpers.js';
import { newId, resumedOf, resumeUnit, seqsOf, slowConnection } from './helpers.js';

const MiB = 1024 * 1024;

/** `n` frames of session `sid` carrying about 1.3 KB of ciphertext each. */
async function seedLarge(u: ReturnType<typeof resumeUnit>, n: number): Promise<void> {
  const from = newId('mem');
  for (let i = 0; i < n; i += 1) {
    const id = newId('msg');
    const frame = stampFrame(
      {
        t: 'event',
        id,
        k: 'message.user',
        ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'n'.repeat(32), c: 'c'.repeat(1_200) },
        sig: 's'.repeat(86),
      },
      from,
      new Date().toISOString(),
      u.sid,
    );
    const result = await u.store.assign(u.sid, { from, id }, frame, Date.now());
    await u.log.append(u.sid, withSeq(frame, result.seq));
  }
}

describe('replay backpressure (acceptance 5)', () => {
  it('5 000 frames: never over 2 MiB buffered, in order, under 2 s', async () => {
    let drain = (): void => undefined;
    let waits = 0;
    const u = resumeUnit({
      resumer: {
        sleep: () => {
          waits += 1;
          drain();
          return new Promise((resolve) => setImmediate(resolve));
        },
      },
    });
    await seedLarge(u, 5_000);
    const conn = slowConnection(u.registry, u.sid, 64 * 1024);
    drain = conn.drain;
    const started = performance.now();
    await u.connect(0, { conn });
    await u.settled(conn);
    const elapsed = performance.now() - started;
    expect(seqsOf(conn)).toEqual(Array.from({ length: 5_000 }, (_, i) => i + 1));
    expect(resumedOf(conn)).toEqual([{ from_seq: 1, to_seq: 5_000, count: 5_000 }]);
    expect(conn.maxBuffered).toBeLessThanOrEqual(WELCOME_LIMITS.outbound_buffer_bytes);
    expect(conn.maxBuffered).toBeGreaterThan(MiB);
    expect(waits).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('closes a client that reads nothing with 4429 slow_consumer and stops the replay', async () => {
    const recorded = recordingMetrics();
    const u = resumeUnit({
      resumer: {
        stallMs: 50,
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
        metrics: recorded.metrics,
      },
    });
    await seedLarge(u, 3_000);
    const conn = slowConnection(u.registry, u.sid, 0);
    await u.connect(0, { conn });
    await u.settled(conn);
    expect(conn.closedWith).toBe(4429);
    expect(conn.frames().find((f) => f['t'] === 'sys.error')).toMatchObject({
      p: { code: 'slow_consumer' },
    });
    const sent = seqsOf(conn);
    expect(sent.length).toBeLessThan(3_000);
    expect(conn.maxBuffered).toBeLessThanOrEqual(WELCOME_LIMITS.outbound_buffer_bytes + 2_000);
    expect(resumedOf(conn)).toEqual([]);
    expect(recorded.count('relay_resume_stalled_total')).toBe(1);
  });

  it('sends a frame larger than the limit alone once the buffer is empty', async () => {
    let drain = (): void => undefined;
    const u = resumeUnit({
      resumer: {
        outboundLimit: 1_000,
        sleep: () => {
          drain();
          return new Promise((resolve) => setImmediate(resolve));
        },
      },
    });
    await seedLarge(u, 3);
    const conn = slowConnection(u.registry, u.sid, 10_000);
    drain = conn.drain;
    await u.connect(0, { conn });
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual([1, 2, 3]);
  });
});

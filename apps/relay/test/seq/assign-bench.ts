/**
 * Assign latency against a real Redis (B041 acceptance 9), run by `seq.perf.test.ts` in a child
 * process (no coverage instrumentation). Reads `{url, keyPrefix, frames, warmup, rate, rounds}` as
 * JSON on stdin, sends `rate` frames per second open loop (each assign starts on schedule, whether
 * or not the previous one finished) to one session whose buffer is kept at its cap, so every
 * measured append also trims: a warm-up, then `rounds` rounds of `frames`, and prints
 * `{rounds: [{count, p50, p95, p99, max, rate}]}` (milliseconds) as JSON.
 * `url: "memory"` runs the same loop on the in-memory store (to check the harness without Redis).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setImmediate as immediate, setTimeout as sleep } from 'node:timers/promises';
import { newId } from '@centcom/contracts';
import { Secret } from '@centcom/core';
import { stampFrame } from '../../src/seq/frame.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { createRedisSeqStore, createSeqRedisClient } from '../../src/seq/redis-store.js';
import type { BufferLimits } from '../../src/seq/types.js';

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  url: string;
  keyPrefix: string;
  frames: number;
  warmup: number;
  rate: number;
  rounds: number;
};

// The buffer reaches its cap during the warm-up, so measured appends trim one frame each.
const limits: BufferLimits = { minFrames: 1_000, minAgeMs: 600_000, maxFrames: 2_000 };
const client =
  input.url === 'memory'
    ? undefined
    : createSeqRedisClient({ url: new Secret(input.url), keyPrefix: input.keyPrefix });
const store =
  client === undefined ? createMemorySeqStore(limits) : createRedisSeqStore(client, limits);
const sid = newId('ses');
// A realistic encrypted message: about 1 KiB of ciphertext.
const ciphertext = 'A'.repeat(1_024);
const interval = 1_000 / input.rate;

/** Sends `count` frames at `rate`, open loop; resolves with each assign's latency (ms) and the rate. */
async function round(count: number): Promise<{ latencies: number[]; rate: number }> {
  const latencies: number[] = [];
  const pending: Promise<void>[] = [];
  const start = performance.now();
  for (let i = 0; i < count; i += 1) {
    const due = start + i * interval;
    for (let left = due - performance.now(); left > 0; left = due - performance.now()) {
      if (left > 2) await sleep(left - 1);
      else await immediate();
    }
    const from = newId('mem');
    const id = newId('msg');
    const frame = stampFrame(
      {
        t: 'event',
        id,
        k: 'message.user',
        ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'bm9uY2U', c: ciphertext },
        sig: 'c2ln',
      },
      from,
      new Date().toISOString(),
      sid,
    );
    const began = performance.now();
    pending.push(
      store.assign(sid, { from, id }, frame, Date.now()).then(() => {
        latencies.push(performance.now() - began);
      }),
    );
  }
  await Promise.all(pending);
  return { latencies, rate: count / ((performance.now() - start) / 1_000) };
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;

await round(input.warmup);
const rounds = [];
for (let r = 0; r < input.rounds; r += 1) {
  const { latencies, rate } = await round(input.frames);
  latencies.sort((a, b) => a - b);
  rounds.push({
    count: latencies.length,
    p50: pct(latencies, 0.5),
    p95: pct(latencies, 0.95),
    p99: pct(latencies, 0.99),
    max: latencies.at(-1),
    rate,
  });
}
client?.disconnect();
process.stdout.write(JSON.stringify({ rounds }));

/**
 * Decode timing (B039 acceptance 8), run in a child process by codec.test.ts so the test runner's
 * coverage does not distort it. Reads `{runs}` from stdin, decodes a 256 KiB frame that many times
 * after a warm-up, and prints `{p95, ok}` (milliseconds; whether every decode succeeded).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { decodeFrame, FRAME_LIMITS } from '../../src/codec/codec.js';
import { FIXTURE_SID, frameOfBytes } from './helpers.js';

const { runs } = JSON.parse(readFileSync(0, 'utf8')) as { runs: number };
const frame = frameOfBytes(FRAME_LIMITS.maxFrameBytes);
let ok = true;
for (let i = 0; i < 20; i += 1) ok = decodeFrame(frame, false, FIXTURE_SID).ok && ok;
const times: number[] = [];
for (let i = 0; i < runs; i += 1) {
  const start = performance.now();
  ok = decodeFrame(frame, false, FIXTURE_SID).ok && ok;
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
process.stdout.write(JSON.stringify({ p95, ok }));

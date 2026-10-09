/**
 * Fan-out benchmark (B044, card test "fanout.bench.ts"): one 50-member room on in-memory sockets;
 * each frame goes through B041's stage and this lane's fan-out; measures per-frame fan-out time
 * (p50/p95) and deliveries per second. `runFanoutBench` is used by `fanout.perf.test.ts`; run it
 * alone with `tsx --tsconfig tsconfig.test.json apps/relay/test/fanout/fanout.bench.ts`.
 */
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fanoutUnit, reactionFrame } from './helpers.js';

/** One run's numbers. */
export interface FanoutBenchResult {
  members: number;
  frames: number;
  p50Ms: number;
  p95Ms: number;
  deliveriesPerSecond: number;
}

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** Runs the benchmark: `frames` frames from one member to a room of `members`. */
export async function runFanoutBench(opts: {
  members: number;
  frames: number;
}): Promise<FanoutBenchResult> {
  const u = fanoutUnit();
  const conns = Array.from({ length: opts.members }, () => u.join());
  const sender = conns[0];
  if (sender === undefined) throw new Error('no members');
  // Warm-up.
  for (let i = 0; i < 200; i++) await u.send(sender, reactionFrame(u.sid));
  for (const c of conns) c.texts.length = 0;
  const times: number[] = [];
  const started = performance.now();
  for (let i = 0; i < opts.frames; i++) {
    const frame = reactionFrame(u.sid);
    const t0 = performance.now();
    await u.send(sender, frame);
    times.push(performance.now() - t0);
  }
  const elapsedS = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  return {
    members: opts.members,
    frames: opts.frames,
    p50Ms: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    deliveriesPerSecond: Math.round((opts.frames * opts.members) / elapsedS),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runFanoutBench({ members: 50, frames: 10_000 }).then((r) => {
    process.stdout.write(`${JSON.stringify(r)}\n`);
  });
}

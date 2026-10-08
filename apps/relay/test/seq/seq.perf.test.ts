/**
 * Assign p95 under 2 ms against Redis at 1 000 frames/s (B041 acceptance 9): assign-bench.ts runs
 * in a child process (no coverage instrumentation, no other test files sharing its event loop)
 * against the test Redis (REDIS_URL or a container; skipped without one) and sends 1 000 frames a
 * second, open loop, to a session whose buffer sits at its cap: three rounds of 3 000 frames after
 * a warm-up, and the best round's p95 must be under 2 ms (a shared CI runner's noise can spoil
 * one round; a slow assign path spoils all three).
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS, REDIS_TIMEOUT_MS, startRedisHarness, type RedisHarness } from './redis-helpers.js';

const run = promisify(execFile);

describe.runIf(REDIS)('assign latency on Redis', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  it(
    'keeps assign p95 under 2 ms at 1 000 frames/s',
    async () => {
      const bench = resolve(import.meta.dirname, 'assign-bench.ts');
      const tsx = createRequire(import.meta.url).resolve('tsx/cli');
      const tsconfig = resolve(import.meta.dirname, '../../../../tsconfig.test.json');
      const child = run(process.execPath, [tsx, '--tsconfig', tsconfig, bench], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      child.child.stdin?.end(
        JSON.stringify({
          url: redis.url,
          keyPrefix: redis.prefix(),
          frames: 3_000,
          warmup: 2_500,
          rate: 1_000,
          rounds: 3,
        }),
      );
      const { stdout } = await child;
      const { rounds } = JSON.parse(stdout) as {
        rounds: {
          count: number;
          p50: number;
          p95: number;
          p99: number;
          max: number;
          rate: number;
        }[];
      };
      expect(rounds).toHaveLength(3);
      for (const r of rounds) {
        expect(r.count).toBe(3_000);
        expect(r.rate).toBeGreaterThan(900);
      }
      expect(Math.min(...rounds.map((r) => r.p95))).toBeLessThan(2);
    },
    REDIS_TIMEOUT_MS,
  );
});

/**
 * Load across nodes (B045; tests "cluster.load.test.ts", acceptance 6 and 7): five nodes, a client
 * on each, about 500 frames a second for two seconds: every client gets every frame once and in
 * order. Cross-node added latency (`relay_cluster_lag_seconds`: the frame's sequencing on its node
 * to its arrival on another) stays under 20 ms at p95 for frames of up to 4 KiB, on a real Redis
 * (REDIS_URL, or a container; skipped when neither is there) and in memory.
 */
import { newId } from '@centcom/contracts';
import { createRedis, keyPrefixFor, Secret } from '@centcom/core';
import type { SimClient } from '@centcom/testkit/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../helpers.js';
import {
  REDIS,
  REDIS_TIMEOUT_MS,
  startRedisHarness,
  type RedisHarness,
} from '../seq/redis-helpers.js';
import { cluster, range, seqs } from './helpers.js';

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0;
};

/** An encrypted `message.user` of about 4 KiB (opaque ciphertext and a signature). */
const encrypted = (sid: string) => ({
  v: 1 as const,
  t: 'event' as const,
  id: newId('msg'),
  sid,
  k: 'message.user',
  ct: {
    alg: 'xchacha20poly1305',
    kid: 'k1',
    n: 'n'.repeat(32),
    c: 'Y'.repeat(3_800),
  },
  sig: 's'.repeat(86),
});

/** Sends `total` frames from `senders` at about `perSecond`, waiting for every echo. */
async function paced(senders: SimClient[], total: number, perSecond: number): Promise<void> {
  const started = Date.now();
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < total; i += 1) {
    const due = started + (i * 1000) / perSecond;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const sender = senders[i % senders.length] as SimClient;
    pending.push(sender.sendFrame(encrypted(sender.sid) as never));
  }
  await Promise.all(pending);
}

async function runLoad(c: Awaited<ReturnType<typeof cluster>>): Promise<number[]> {
  const clients = await Promise.all(c.nodes.map((node) => c.client(node)));
  // Every node listens to the session before the run, so every frame takes the pub/sub path.
  await until(() => c.nodes.every((node) => node.cluster().sessions().includes(c.sid)), 5_000);
  await paced(clients, 1_000, 500);
  await until(() => clients.every((cl) => seqs(cl).length >= 1_000), 20_000);
  for (const cl of clients) expect(seqs(cl)).toEqual(range(1, 1_000));
  return c.nodes.flatMap((node) => node.metrics.observed('relay_cluster_lag_seconds'));
}

describe('five nodes at 500 frames/s (in memory)', () => {
  it('every client gets every frame once, in order; lag p95 < 20 ms', async () => {
    const c = await cluster(5);
    try {
      const lags = await runLoad(c);
      expect(lags.length).toBeGreaterThanOrEqual(4_000);
      expect(p95(lags)).toBeLessThan(0.02);
    } finally {
      await c.stop();
    }
  }, 60_000);
});

describe.runIf(REDIS)('five nodes at 500 frames/s on Redis 7', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  it('cross-node lag p95 < 20 ms for 4 KiB frames (acceptance 7)', async () => {
    const prefix = keyPrefixFor(`t${Date.now().toString(36)}`);
    const c = await cluster(5, {
      backend: () => createRedis({ url: new Secret(redis.url), keyPrefix: prefix }),
    });
    try {
      const lags = await runLoad(c);
      expect(lags.length).toBeGreaterThanOrEqual(4_000);
      expect(p95(lags), `p95 ${p95(lags)}`).toBeLessThan(0.02);
    } finally {
      await c.stop();
    }
  }, 120_000);
});

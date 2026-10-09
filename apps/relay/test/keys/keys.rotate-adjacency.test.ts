/**
 * Kick and rotation adjacency (B049; tests "keys.rotate-adjacency.test.ts", acceptance 4,
 * CT-WS-CONTROL "kick + rotate_key are emitted back-to-back with consecutive seq numbers"): with a
 * concurrent flood of about 100 frames a second from other members, `rotate(sid, "member_removed",
 * {after: kick})` sequences the kick and the `rotate_key` with consecutive `seq`s, every time, in
 * memory and on Redis 7 (one MULTI/EXEC: no other node's frame can come between).
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEpochs } from '../../src/keys/epochs.js';
import { createMemoryEpochStore } from '../../src/keys/epoch-store.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { stampFrame } from '../../src/seq/frame.js';
import type { SeqStore } from '../../src/seq/types.js';
import { createSequencer } from '../../src/seq/stage.js';
import { LIMITS, reaction } from '../seq/helpers.js';
import {
  REDIS,
  REDIS_TIMEOUT_MS,
  startRedisHarness,
  type RedisHarness,
} from '../seq/redis-helpers.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';

async function adjacency(store: SeqStore, rounds: number): Promise<[number, number][]> {
  const sid = newId('ses');
  const sequencer = createSequencer({ store, rate: 1_000_000, burst: 1_000_000 });
  const fanout = createFanOut({ rooms: createRoomRegistry(), seq: sequencer.service });
  const epochs = createEpochs({
    store: createMemoryEpochStore(),
    seq: store,
    fanout: () => fanout,
  });
  let flooding = true;
  // Other members flood the session (straight to the store, as other nodes would).
  const flood = (async () => {
    while (flooding) {
      const from = newId('mem');
      await Promise.all(
        Array.from({ length: 5 }, () => {
          const fid = newId('msg');
          return store.assign(
            sid,
            { from, id: fid },
            stampFrame({ t: 'event', id: fid, k: 'reaction', p: reaction() }, from, 'ts', sid),
            Date.now(),
          );
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const pairs: [number, number][] = [];
  for (let i = 0; i < rounds; i += 1) {
    const kick = { kind: 'control.kick', t: 'control' as const, p: { member: newId('mem') } };
    const { seq } = await epochs.rotate(sid, 'member_removed', { after: kick });
    const [kicked] = await store.range(sid, seq - 2, 1);
    pairs.push([kicked?.k === 'control.kick' ? kicked.seq : -1, seq]);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  flooding = false;
  await flood;
  return pairs;
}

describe('kick + rotate_key adjacency (acceptance 4)', () => {
  it('consecutive seqs under a flood, in memory', async () => {
    const pairs = await adjacency(createMemorySeqStore(LIMITS), 20);
    for (const [kick, rotate] of pairs) expect(rotate - kick).toBe(1);
  });
});

describe.runIf(REDIS)('on Redis 7', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  it('consecutive seqs under a flood (MULTI/EXEC)', async () => {
    const pairs = await adjacency(redis.store(LIMITS).store, 20);
    for (const [kick, rotate] of pairs) expect(rotate - kick).toBe(1);
  }, 120_000);
});

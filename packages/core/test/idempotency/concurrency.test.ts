/**
 * Concurrency (B024, card test concurrency.test.ts; acceptance 5): 20 parallel claims of one key
 * leave exactly one runner; the rest replay its result, and parallel claims of different requests
 * under one key leave one runner and conflicts. On every backend: in memory, and on Redis 7 when
 * REDIS_URL is set (CI's integration job).
 */
import { randomUUID } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { storeKeyFor, type Claim } from '../../src/index.js';
import { HARNESSES, type Harness } from '../redis/helpers.js';
import { fp, jsonResponse, quickStore } from './helpers.js';

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`idempotency under concurrency: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    it('lets exactly one of 20 parallel identical claims run, and the rest replay it', async () => {
      harness = await open();
      const store = quickStore(harness.backend.kv);
      const key = storeKeyFor(newId('usr'), 'POST', '/v1/things', randomUUID());
      const response = jsonResponse(201, { id: 'thing' });
      const claims = await Promise.all(
        Array.from({ length: 20 }, async (): Promise<Claim> => {
          const claim = await store.claim(key, fp({ a: 1 }));
          if (claim.kind === 'claimed') {
            await new Promise((resolve) => setTimeout(resolve, 25));
            await store.complete(key, fp({ a: 1 }), response);
          }
          return claim;
        }),
      );
      const kinds = claims.map((c) => c.kind);
      expect(kinds.filter((k) => k === 'claimed')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'replay')).toHaveLength(19);
      expect(JSON.parse((await harness.backend.kv.get(key)) ?? '{}')).toMatchObject({
        state: 'done',
        status: 201,
      });
    });

    it('lets one of 20 different requests under one key run, and refuses the rest', async () => {
      harness = await open();
      const store = quickStore(harness.backend.kv);
      const key = storeKeyFor(newId('usr'), 'POST', '/v1/things', randomUUID());
      const claims = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.claim(key, fp({ attempt: i }))),
      );
      const kinds = claims.map((c) => c.kind);
      expect(kinds.filter((k) => k === 'claimed')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'conflict')).toHaveLength(19);
    });
  });
}

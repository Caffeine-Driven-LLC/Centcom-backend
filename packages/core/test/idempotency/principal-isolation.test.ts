/**
 * Principal isolation (B024, card test principal-isolation.test.ts; acceptance 8): the store key
 * covers the principal, method, route template and key, so the same key string from two callers
 * (or on two routes) never meets, and no choice of values makes two scopes encode alike.
 */
import { randomUUID } from 'node:crypto';
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryRedis, storeKeyFor } from '../../src/index.js';
import { fp, jsonResponse, quickStore } from './helpers.js';

describe('store keys', () => {
  it('differ by principal, anonymity, method, route and key', () => {
    const user = newId('usr');
    const key = randomUUID();
    const base = storeKeyFor(user, 'POST', '/v1/things', key);
    expect(base).toMatch(/^idem:[0-9a-f]{64}$/);
    expect(storeKeyFor(user, 'post', '/v1/things', key)).toBe(base);
    for (const other of [
      storeKeyFor(newId('usr'), 'POST', '/v1/things', key),
      storeKeyFor(newId('key'), 'POST', '/v1/things', key),
      storeKeyFor(null, 'POST', '/v1/things', key),
      storeKeyFor('null', 'POST', '/v1/things', key),
      storeKeyFor(user, 'PUT', '/v1/things', key),
      storeKeyFor(user, 'POST', '/v1/other', key),
      storeKeyFor(user, 'POST', '/v1/things', randomUUID()),
    ]) {
      expect(other).not.toBe(base);
    }
  });

  it('never encode two different scopes alike (property)', () => {
    const part = fc.string({ maxLength: 12 });
    const scope = fc.tuple(fc.option(part), part, part, part);
    fc.assert(
      fc.property(scope, scope, (a, b) => {
        // The method counts case-insensitively; anything else that differs is another scope.
        const same = (s: typeof a): string =>
          JSON.stringify([s[0], s[1].toUpperCase(), s[2], s[3]]);
        fc.pre(same(a) !== same(b));
        expect(storeKeyFor(...a)).not.toBe(storeKeyFor(...b));
      }),
      { numRuns: 500 },
    );
  });
});

describe('the same key from two principals (acceptance 8)', () => {
  it('runs for each, and replays to each only its own response', async () => {
    const kv = createMemoryRedis().kv;
    const store = quickStore(kv);
    const key = randomUUID();
    const [alice, bob] = [newId('usr'), newId('usr')];
    const aliceKey = storeKeyFor(alice, 'POST', '/v1/things', key);
    const bobKey = storeKeyFor(bob, 'POST', '/v1/things', key);
    expect(await store.claim(aliceKey, fp({}))).toEqual({ kind: 'claimed' });
    await store.complete(aliceKey, fp({}), jsonResponse(201, { owner: alice }));
    expect(await store.claim(bobKey, fp({}))).toEqual({ kind: 'claimed' });
    await store.complete(bobKey, fp({}), jsonResponse(201, { owner: bob }));
    const replays = [await store.claim(aliceKey, fp({})), await store.claim(bobKey, fp({}))];
    expect(
      replays.map((r) => (r.kind === 'replay' ? JSON.parse(r.response.body.toString()) : null)),
    ).toEqual([{ owner: alice }, { owner: bob }]);
  });
});

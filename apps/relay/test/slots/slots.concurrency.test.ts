/**
 * Concurrent joins (B031 acceptance 2, guardrail; card test slots.concurrency.test.ts): 50 members
 * joining at once get exactly {0..49}; the 51st gets SlotsExhaustedError; and over random join
 * orders, with members joining several times at once, every member ends with one slot and the
 * slots are 0..n-1 without gaps or duplicates.
 */
import { describe, expect, it } from 'vitest';
import {
  createSlotService,
  MAX_SESSION_MEMBERS,
  SlotsExhaustedError,
} from '../../src/slots/index.js';
import { members, shuffled } from './helpers.js';
import { places } from './places.js';

for (const place of places()) {
  describe.runIf(place.enabled)(`concurrent slots ${place.name}`, () => {
    place.hooks();

    it('gives 50 members joining at once exactly the slots 0 to 49 (acceptance 2)', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const session = await env.newSession();
      const fifty = members(MAX_SESSION_MEMBERS);
      const got = await Promise.all(fifty.map((m) => slots.assign(session, m)));
      expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
      expect(new Set(got).size).toBe(50);

      const err = await slots.assign(session, members(1)[0] ?? '').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SlotsExhaustedError);
      expect(err).toMatchObject({ code: 'session_full', status: 403 });
      // The 50 keep theirs.
      expect(await Promise.all(fifty.map((m) => slots.assign(session, m)))).toEqual(got);
    }, 60_000);

    it('refuses the 51st of 51 members joining at once, and only that one', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const session = await env.newSession();
      const results = await Promise.allSettled(members(51).map((m) => slots.assign(session, m)));
      const ok = results.filter(
        (r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled',
      );
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok.map((r) => r.value).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toBeInstanceOf(SlotsExhaustedError);
    }, 60_000);

    it('gives every member one slot, 0..n-1, over random join orders with repeated joins (property)', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const rounds = place.name === 'in memory' ? 200 : 15;
      for (let seed = 1; seed <= rounds; seed++) {
        const session = await env.newSession();
        const people = members(1 + (seed % 20));
        // Every member joins 1-3 times, all at once, in a random order.
        const joins = shuffled(
          people.flatMap((m, i) => Array<string>(1 + ((seed + i) % 3)).fill(m)),
          seed,
        );
        const got = await Promise.all(joins.map((m) => slots.assign(session, m)));
        const byMember = new Map<string, Set<number>>();
        joins.forEach((m, i) => byMember.set(m, (byMember.get(m) ?? new Set()).add(got[i] ?? -1)));
        for (const [member, seen] of byMember) expect(seen.size, `seed ${seed} ${member}`).toBe(1);
        const list = await slots.list(session);
        expect(
          list.map((s) => s.slot),
          `seed ${seed}`,
        ).toEqual(people.map((_, i) => i));
      }
    }, 120_000);
  });
}

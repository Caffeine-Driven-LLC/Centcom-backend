/**
 * No reuse (B031 acceptance 3, guardrail; card test slots.no-reuse.test.ts): leaving frees
 * nothing. Over random interleavings of joins, leaves and rejoins, a new member always gets a
 * slot above every slot handed out before, and a returning member gets their own back.
 */
import { describe, expect, it } from 'vitest';
import { createSlotService } from '../../src/slots/index.js';
import { members, shuffled } from './helpers.js';
import { places } from './places.js';

for (const place of places()) {
  describe.runIf(place.enabled)(`slot reuse ${place.name}`, () => {
    place.hooks();

    it('gives a newcomer after a leave a higher slot, and the leaver theirs back (acceptance 3)', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const session = await env.newSession();
      const [a, b, c] = members(3) as [string, string, string];
      expect(await slots.assign(session, a)).toBe(0);
      expect(await slots.assign(session, b)).toBe(1);
      // b leaves (or is kicked): the slot service is not told, and keeps b's slot.
      expect(await slots.assign(session, c)).toBe(2);
      expect(await slots.assign(session, b)).toBe(1);
    });

    it('never reuses a slot over random join, leave and rejoin interleavings', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const rounds = place.name === 'in memory' ? 100 : 10;
      for (let seed = 1; seed <= rounds; seed++) {
        const session = await env.newSession();
        const people = members(12);
        // Each person joins, maybe leaves, maybe comes back: a random sequence of events.
        const events = shuffled(
          people.flatMap((m, i) => [
            { m, kind: 'join' as const },
            ...((seed + i) % 2 === 0
              ? [
                  { m, kind: 'leave' as const },
                  { m, kind: 'join' as const },
                ]
              : []),
          ]),
          seed,
        );
        const first = new Map<string, number>();
        let highest = -1;
        for (const event of events) {
          if (event.kind === 'leave') continue;
          const slot = await slots.assign(session, event.m);
          const before = first.get(event.m);
          if (before === undefined) {
            expect(slot, `seed ${seed}`).toBe(highest + 1);
            highest = slot;
            first.set(event.m, slot);
          } else {
            expect(slot, `seed ${seed}`).toBe(before);
          }
        }
        expect(new Set(first.values()).size).toBe(first.size);
      }
    }, 120_000);
  });
}

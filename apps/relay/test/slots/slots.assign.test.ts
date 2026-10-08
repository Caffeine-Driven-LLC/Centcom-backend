/**
 * Assigning slots (B031 acceptance 1 and 5; card test slots.assign.test.ts): 0, 1, 2 in join
 * order; the same slot again for the same member; `get` and `list` for the roster; an unknown
 * session; and deleting one session's slots without touching another's.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createSlotService, SessionNotFoundError } from '../../src/slots/index.js';
import { members } from './helpers.js';
import { places } from './places.js';

for (const place of places()) {
  describe.runIf(place.enabled)(`slots ${place.name}`, () => {
    place.hooks();

    it('gives the first members 0, 1 and 2, and a member the same slot every time (acceptance 1)', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const session = await env.newSession();
      const [a, b, c] = members(3) as [string, string, string];
      expect(await slots.assign(session, a)).toBe(0);
      expect(await slots.assign(session, b)).toBe(1);
      expect(await slots.assign(session, a)).toBe(0);
      expect(await slots.assign(session, c)).toBe(2);
      expect(await slots.assign(session, b)).toBe(1);
      expect(await slots.get(session, c)).toBe(2);
      expect(await slots.get(session, newId('mem'))).toBeNull();
      expect(await slots.list(session)).toEqual([
        { memberId: a, slot: 0 },
        { memberId: b, slot: 1 },
        { memberId: c, slot: 2 },
      ]);
    });

    it('numbers each session from 0', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const [one, two] = [await env.newSession(), await env.newSession()];
      const [a, b] = members(2) as [string, string];
      expect(await slots.assign(one, a)).toBe(0);
      expect(await slots.assign(two, b)).toBe(0);
      // The same member in another session gets a slot of that session.
      expect(await slots.assign(two, a)).toBe(1);
    });

    it('refuses a session that does not exist with SessionNotFoundError (session_not_found)', async () => {
      const slots = createSlotService(place.env().store);
      for (const session of [newId('ses'), 'ses_nope', '']) {
        const err = await slots.assign(session, newId('mem')).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SessionNotFoundError);
        expect(err).toMatchObject({ code: 'session_not_found', status: 404 });
      }
    });

    it('refuses a member id that is not a mem_ id', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      await expect(
        slots.assign(await env.newSession(), 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W'),
      ).rejects.toThrow(TypeError);
    });

    it('deletes one session’s slots and leaves the others (acceptance 5)', async () => {
      const env = place.env();
      const slots = createSlotService(env.store);
      const [gone, kept] = [await env.newSession(), await env.newSession()];
      for (const member of members(3)) {
        await slots.assign(gone, member);
        await slots.assign(kept, member);
      }
      await slots.deleteForSession(gone);
      expect(await slots.list(gone)).toEqual([]);
      expect((await slots.list(kept)).map((s) => s.slot)).toEqual([0, 1, 2]);
      // The emptied session numbers from 0 again; the other keeps counting.
      expect(await slots.assign(gone, newId('mem'))).toBe(0);
      expect(await slots.assign(kept, newId('mem'))).toBe(3);
    });
  });
}

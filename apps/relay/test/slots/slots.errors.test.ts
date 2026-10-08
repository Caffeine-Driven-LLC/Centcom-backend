/**
 * Slot failures (B031 failure modes): a unique violation is retried up to 3 times, then answered
 * with a retryable 503; a lost connection or the 2 s statement timeout is a 503 too, with nothing
 * kept in memory; other errors pass through unchanged.
 */
import { newId } from '@centcom/contracts';
import { toProblem } from '@centcom/core';
import type { SessionSlotStore } from '@centcom/db';
import { describe, expect, it } from 'vitest';
import { createSlotService, SLOT_ASSIGN_ATTEMPTS } from '../../src/slots/index.js';
import { memorySlotStore } from './helpers.js';

const failing = (code: string, message = 'boom'): Error =>
  Object.assign(new Error(message), { code });

/** A memory store whose `assign` throws `errors` first, then works. */
function flaky(errors: Error[]): SessionSlotStore & { calls: number; sessions: Set<string> } {
  const store = memorySlotStore();
  const wrapped = {
    ...store,
    calls: 0,
    assign(sessionId: string, memberId: string, cap: number) {
      wrapped.calls++;
      const next = errors.shift();
      return next === undefined ? store.assign(sessionId, memberId, cap) : Promise.reject(next);
    },
  };
  return wrapped;
}

describe('slot failures', () => {
  it('retries a unique violation and returns the committed slot', async () => {
    const store = flaky([failing('23505'), failing('23505')]);
    const session = newId('ses');
    store.sessions.add(session);
    expect(await createSlotService(store).assign(session, newId('mem'))).toBe(0);
    expect(store.calls).toBe(3);
  });

  it(`gives up after ${SLOT_ASSIGN_ATTEMPTS} unique violations with a retryable 503`, async () => {
    const store = flaky([failing('23505'), failing('23505'), failing('23505'), failing('23505')]);
    const session = newId('ses');
    store.sessions.add(session);
    const err = await createSlotService(store)
      .assign(session, newId('mem'))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(store.calls).toBe(SLOT_ASSIGN_ATTEMPTS);
    expect(toProblem(err, { requestId: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W' })).toMatchObject({
      retry_after_s: 1,
    });
    expect(await store.list(session)).toEqual([]);
  });

  it.each([
    ['a lost connection', failing('ECONNRESET', 'read ECONNRESET 10.0.0.5:5432')],
    ['the 2 s statement timeout', failing('57014', 'canceling statement due to statement timeout')],
  ])('turns %s into a 503 that does not name the database', async (_label, error) => {
    const store = flaky([error]);
    const session = newId('ses');
    store.sessions.add(session);
    const err = await createSlotService(store)
      .assign(session, newId('mem'))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'service_unavailable' });
    expect(
      JSON.stringify(toProblem(err, { requestId: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W' })),
    ).not.toContain('10.0.0.5');
  });

  it('passes other errors through, and reads fail the same way', async () => {
    const odd = new Error('something else');
    const store = flaky([odd]);
    const session = newId('ses');
    store.sessions.add(session);
    const slots = createSlotService(store);
    await expect(slots.assign(session, newId('mem'))).rejects.toBe(odd);

    const broken: SessionSlotStore = {
      assign: () => Promise.reject(failing('ECONNREFUSED')),
      get: () => Promise.reject(failing('ECONNREFUSED')),
      list: () => Promise.reject(failing('57014')),
      deleteForSession: () => Promise.reject(failing('ECONNREFUSED')),
    };
    const down = createSlotService(broken);
    await expect(down.get(session, newId('mem'))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await expect(down.list(session)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(down.deleteForSession(session)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
});

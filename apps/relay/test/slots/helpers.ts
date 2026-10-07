/**
 * Test helpers for member slots (B031): an in-memory SessionSlotStore with the Postgres store's
 * rules (one assignment at a time per call, as the session row lock makes them), and the two
 * places the shared suites run: in memory always, and on Postgres 16 (B010's test stack) where one
 * can start: DATABASE_URL and REDIS_URL set (CI's integration job) or a container runtime (CI's
 * test job).
 */
import { newId } from '@centcom/contracts';
import { defineConfig, z } from '@centcom/core';
import { createSessionSlotStore, type SessionSlotStore, type SlotAssignment } from '@centcom/db';
import {
  sessionFactory,
  startTestStack,
  testcontainersRuntime,
  type TestStack,
} from '@centcom/testkit';

/** The database the slot store takes. */
export type SlotDb = Parameters<typeof createSessionSlotStore>[0];

const env = defineConfig(
  z.object({ DATABASE_URL: z.string().optional(), REDIS_URL: z.string().optional() }),
);
/** A test stack can start here. */
export const STACK =
  (env.DATABASE_URL !== undefined && env.REDIS_URL !== undefined) ||
  (await testcontainersRuntime.check().then(
    () => true,
    () => false,
  ));
export const STACK_TIMEOUT_MS = 180_000;

/** Slots in memory, by the Postgres store's rules. */
export function memorySlotStore(): SessionSlotStore & {
  sessions: Set<string>;
  slots: Map<string, Map<string, number>>;
} {
  const sessions = new Set<string>();
  const slots = new Map<string, Map<string, number>>();
  return {
    sessions,
    slots,
    assign(sessionId, memberId, cap): Promise<SlotAssignment> {
      if (!sessions.has(sessionId)) return Promise.resolve({ kind: 'no_session' });
      const held = slots.get(sessionId) ?? new Map<string, number>();
      slots.set(sessionId, held);
      const existing = held.get(memberId);
      if (existing !== undefined)
        return Promise.resolve({ kind: 'assigned', slot: existing, existing: true });
      const next = held.size === 0 ? 0 : Math.max(...held.values()) + 1;
      if (next >= cap) return Promise.resolve({ kind: 'full' });
      held.set(memberId, next);
      return Promise.resolve({ kind: 'assigned', slot: next, existing: false });
    },
    get: (sessionId, memberId) => Promise.resolve(slots.get(sessionId)?.get(memberId) ?? null),
    list: (sessionId) =>
      Promise.resolve(
        [...(slots.get(sessionId) ?? new Map<string, number>())]
          .map(([memberId, slot]) => ({ memberId, slot }))
          .sort((a, b) => a.slot - b.slot),
      ),
    deleteForSession(sessionId) {
      const n = slots.get(sessionId)?.size ?? 0;
      slots.delete(sessionId);
      return Promise.resolve(n);
    },
  };
}

/** Where a suite runs: a store, and a way to make sessions in it. */
export interface SlotEnv {
  store: SessionSlotStore;
  newSession(): Promise<string>;
}

/** The in-memory place. */
export function memoryEnv(): SlotEnv {
  const store = memorySlotStore();
  return {
    store,
    newSession: () => {
      const id = newId('ses');
      store.sessions.add(id);
      return Promise.resolve(id);
    },
  };
}

/** The Postgres place, on a test stack (started by the caller, stopped by it too). */
export function postgresEnv(stack: TestStack): SlotEnv {
  const db = stack.db as unknown as SlotDb;
  const sessions = sessionFactory(stack.db);
  return {
    store: createSessionSlotStore(db),
    newSession: async () => (await sessions.create()).id,
  };
}

export { startTestStack, type TestStack };

/** `n` distinct member ids. */
export const members = (n: number): string[] => Array.from({ length: n }, () => newId('mem'));

/** A seeded shuffle (mulberry32), so a failing order can be replayed from its seed. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const random = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

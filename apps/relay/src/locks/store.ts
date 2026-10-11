/**
 * Lock stores (B059): Redis (B009's KeyValue) and in memory (tests).
 *
 * - **Session state:** `locks:<sid>`, one JSON document with the held locks and the wait queues of
 *   the session, kept a day after its last change.
 * - **Lock keys:** `lock:<sid>:<path_hmac>` -> `{agent, member, expires_at}`, written with the
 *   lock's TTL (`PX`), so Redis expires a lock on its own if no sweep runs; deleted on release.
 * - **Atomicity:** every change runs under `locks:<sid>:mutex` (`SET NX PX` through
 *   `setIfAbsent`, 30 s, released when the change is done; waited for at most 2 s): no two holders of a path can exist. Redis down: a
 *   503-class error, never an unsynchronised grant.
 *
 * Keys and values hold the session id, `path_hmac`, agent and member ids, TTLs and times only;
 * `locks.privacy.test.ts` scans them.
 *
 * Owns: persistence. Must not: store anything from `ct` (the path).
 */
import { randomBytes } from 'node:crypto';
import { AppError, type KeyValue } from '@centcom/core';
import type { HeldLock, LockStore, LockTx, SessionLocks, Waiter } from './ports.js';

/** How long a session's document is kept after its last change. */
export const LOCK_DOC_TTL_MS = 24 * 3_600_000;
/** How long the session mutex lives at most. */
export const LOCK_MUTEX_TTL_MS = 30_000;
/** How long a frame waits for the mutex. */
export const LOCK_MUTEX_WAIT_MS = 2_000;

const docKey = (sid: string): string => `locks:${sid}`;
const mutexKey = (sid: string): string => `locks:${sid}:mutex`;
/** A held lock's own key. */
export const lockKey = (sid: string, path: string): string => `lock:${sid}:${path}`;

const unavailable = (): AppError =>
  new AppError('service_unavailable', {
    detail: 'File locks cannot be changed right now; try again shortly.',
    retryAfterS: 1,
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

/** The document of `state`. */
function encode(state: SessionLocks): string {
  return JSON.stringify({
    v: 1,
    locks: [...state.locks].map(([hmac, l]) => ({ hmac, ...l })),
    queues: [...state.queues].map(([hmac, waiters]) => ({ hmac, waiters })),
    members: [...state.members].map(([member, nodes]) => ({ member, nodes })),
    departed: [...state.departed].map(([member, mark]) => ({ member, mark })),
  });
}

/** A document's state; empty for a missing or unreadable one. */
function decode(text: string | null): SessionLocks {
  const state: SessionLocks = {
    locks: new Map(),
    queues: new Map(),
    members: new Map(),
    departed: new Map(),
  };
  if (text === null) return state;
  try {
    const raw = JSON.parse(text) as {
      v?: unknown;
      locks?: (HeldLock & { hmac: string })[];
      queues?: { hmac: string; waiters: Waiter[] }[];
      members?: { member: string; nodes: string[] }[];
      departed?: { member: string; mark: string }[];
    };
    if (raw.v !== 1) return state;
    for (const l of raw.locks ?? []) {
      state.locks.set(l.hmac, {
        agent: l.agent,
        member: l.member,
        expiresAt: l.expiresAt,
        ttlMs: l.ttlMs,
      });
    }
    for (const q of raw.queues ?? []) state.queues.set(q.hmac, q.waiters);
    for (const m of raw.members ?? []) state.members.set(m.member, m.nodes);
    for (const d of raw.departed ?? []) state.departed.set(d.member, d.mark);
  } catch {
    // An unreadable document: start over (the lock keys still expire on their own).
  }
  return state;
}

/** Locks in Redis over `kv`. */
export function createRedisLockStore(deps: {
  kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  mutexWaitMs?: number;
}): LockStore {
  const clock = deps.clock ?? Date.now;
  const kv = deps.kv;
  const wait = deps.mutexWaitMs ?? LOCK_MUTEX_WAIT_MS;
  return {
    async withSession(sid, fn) {
      const token = randomBytes(12).toString('base64url');
      const deadline = clock() + wait;
      for (;;) {
        let got: boolean;
        try {
          got = await kv.setIfAbsent(mutexKey(sid), token, LOCK_MUTEX_TTL_MS);
        } catch {
          throw unavailable();
        }
        if (got) break;
        if (clock() >= deadline) throw unavailable();
        await sleep(10);
      }
      let before: SessionLocks | null = null;
      try {
        const tx: LockTx = {
          async load() {
            before = decode(await kv.get(docKey(sid)));
            return {
              locks: new Map(before.locks),
              queues: new Map(before.queues),
              members: new Map(before.members),
              departed: new Map(before.departed),
            };
          },
          async save(state) {
            await kv.set(docKey(sid), encode(state), { ttlMs: LOCK_DOC_TTL_MS });
            const now = clock();
            for (const [path, l] of state.locks) {
              const ttl = Math.max(1, l.expiresAt - now);
              await kv.set(
                lockKey(sid, path),
                JSON.stringify({ agent: l.agent, member: l.member, expires_at: l.expiresAt }),
                { ttlMs: ttl },
              );
            }
            for (const path of before?.locks.keys() ?? []) {
              if (!state.locks.has(path)) await kv.del(lockKey(sid, path));
            }
            before = state;
          },
        };
        return await fn(tx);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw unavailable();
      } finally {
        try {
          if ((await kv.get(mutexKey(sid))) === token) await kv.del(mutexKey(sid));
        } catch {
          // The mutex expires on its own.
        }
      }
    },
  };
}

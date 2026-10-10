/**
 * One run of a policy at a time (B090): a Redis lock per policy (`retention:lock:<policy>`, B009's
 * `KeyValue`, under the deployment's key prefix), taken with SET NX and a short TTL that the
 * holder renews while it works. A worker that dies leaves the lock to expire within
 * RETENTION_LOCK_TTL_MS, so the job's retry (or the next night) can finish the work.
 *
 * Renewing and releasing check the stored token first; between the check and the write another
 * holder could only have taken an expired lock, which the renewal period (a quarter of the TTL)
 * makes practically impossible.
 *
 * Owns: the lock. Must not: block (a busy lock is reported, not waited for).
 */
import { randomUUID } from 'node:crypto';
import type { KeyValue } from '@centcom/core';

/** How long a lock lives without renewal (a retry, at least 90 s later, finds it gone). */
export const RETENTION_LOCK_TTL_MS = 60 * 1000;
/** How often the holder renews it. */
export const RETENTION_LOCK_RENEW_MS = 15 * 1000;

/** The lock's key. */
export const retentionLockKey = (policy: string): string => `retention:lock:${policy}`;

/** A held lock. */
export interface HeldLock {
  release(): Promise<void>;
}

/** Locks per policy. */
export interface PolicyLock {
  /** Takes the policy's lock, or null when another run holds it. */
  acquire(policy: string): Promise<HeldLock | null>;
}

/** The lock on `kv`. */
export function createPolicyLock(
  kv: Pick<KeyValue, 'setIfAbsent' | 'get' | 'set' | 'del'>,
  options: { ttlMs?: number; renewMs?: number } = {},
): PolicyLock {
  const ttlMs = options.ttlMs ?? RETENTION_LOCK_TTL_MS;
  const renewMs = options.renewMs ?? RETENTION_LOCK_RENEW_MS;
  return {
    async acquire(policy) {
      const key = retentionLockKey(policy);
      const token = randomUUID();
      if (!(await kv.setIfAbsent(key, token, ttlMs))) return null;
      const timer = setInterval(() => {
        void (async () => {
          if ((await kv.get(key)) === token) await kv.set(key, token, { ttlMs });
        })().catch(() => undefined);
      }, renewMs);
      timer.unref();
      return {
        async release() {
          clearInterval(timer);
          try {
            if ((await kv.get(key)) === token) await kv.del(key);
          } catch {
            // It expires on its own.
          }
        },
      };
    },
  };
}

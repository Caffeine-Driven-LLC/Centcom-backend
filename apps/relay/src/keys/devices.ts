/**
 * Whose devices may receive a grant (B049): a `key.grant`'s `to_device` must be a device, not
 * revoked, of a user who is a current member of the session (CT-CRYPTO §4). Postgres answers;
 * answers are cached for CACHE_MS (a new device is usually granted right after joining, so a
 * negative answer is never cached). A database failure is thrown: the grant is refused 503
 * (fail closed), never routed unchecked.
 *
 * Owns: the lookup. Must not: answer from a client's claim.
 */
import type { RelayDb } from '../modules.js';

/** A positive answer is reused this long. */
export const DEVICE_CACHE_MS = 2_000;

/** The port. */
export interface SessionDevices {
  isMemberDevice(sid: string, dev: string): Promise<boolean>;
}

/** Over Postgres (`devices`, `session_members`). */
export function createPostgresSessionDevices(
  db: RelayDb,
  clock: () => number = Date.now,
): SessionDevices {
  const cache = new Map<string, number>();
  return {
    async isMemberDevice(sid, dev) {
      const key = `${sid}\u0000${dev}`;
      const until = cache.get(key);
      if (until !== undefined && until > clock()) return true;
      const row = await db
        .selectFrom('devices as d')
        .innerJoin('session_members as sm', 'sm.user_id', 'd.user_id')
        .select('d.id')
        .where('d.id', '=', dev)
        .where('d.revoked_at', 'is', null)
        .where('sm.session_id', '=', sid)
        .where('sm.left_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) return false;
      cache.set(key, clock() + DEVICE_CACHE_MS);
      if (cache.size > 10_000) cache.delete(cache.keys().next().value as string);
      return true;
    },
  };
}

/** In memory (tests): the devices allowed per session. */
export function createMemorySessionDevices(): SessionDevices & {
  allow(sid: string, dev: string): void;
  failing: boolean;
} {
  const allowed = new Set<string>();
  const devices = {
    failing: false,
    allow: (sid: string, dev: string) => void allowed.add(`${sid}\u0000${dev}`),
    isMemberDevice(sid: string, dev: string) {
      if (devices.failing) return Promise.reject(new Error('database down'));
      return Promise.resolve(allowed.has(`${sid}\u0000${dev}`));
    },
  };
  return devices;
}

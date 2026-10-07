/**
 * Membership state for RBAC (B021): the roles an actor holds, read through a `MembershipReader`
 * (Postgres: `createMembershipRepo` in @centcom/db). `cachedMembershipReader` keeps answers at most
 * 2 s (CT-RBAC rule 2) and drops them at once on an `rbac:invalidate` message, which code that
 * changes a membership publishes.
 *
 * Owns: role lookup and its cache. Must not: keep an answer longer than 2 s, or cache a failure.
 */
import type { PubSub, Unsubscribe } from '../redis/types.js';
import { isSessionRole, isWorkspaceRole, type SessionRole, type WorkspaceRole } from './actions.js';

/** Reads the roles membership state gives a user. */
export interface MembershipReader {
  /** The user's role in the workspace, or null when not a member (or the workspace is gone). */
  workspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null>;
  /** The user's role in the session, or null when not in it. */
  sessionRole(userId: string, sessionId: string): Promise<SessionRole | null>;
}

/** The pub/sub channel of invalidations. */
export const RBAC_INVALIDATE_CHANNEL = 'rbac:invalidate';
/** The longest an answer may be reused (CT-RBAC rule 2). */
export const MEMBERSHIP_CACHE_TTL_MS = 2_000;
/** The most answers kept. */
export const MEMBERSHIP_CACHE_MAX_ENTRIES = 10_000;

/** What an invalidation drops: answers matching every field given; none given drops everything. */
export interface Invalidation {
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}

interface Entry {
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  role: WorkspaceRole | SessionRole | null;
  expiresAt: number;
}

/** A cached reader; `invalidate` drops matching answers. */
export interface CachedMembershipReader extends MembershipReader {
  invalidate(target?: Invalidation): void;
  /** Answers held (expired ones included until next touched). */
  size(): number;
}

/** Caches `inner` for `ttlMs` (at most 2 s). Failures are not cached. */
export function cachedMembershipReader(
  inner: MembershipReader,
  opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
): CachedMembershipReader {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? MEMBERSHIP_CACHE_TTL_MS;
  if (!(ttlMs >= 0 && ttlMs <= MEMBERSHIP_CACHE_TTL_MS)) {
    throw new RangeError(`cachedMembershipReader: ttlMs must be 0 to ${MEMBERSHIP_CACHE_TTL_MS}`);
  }
  const maxEntries = opts.maxEntries ?? MEMBERSHIP_CACHE_MAX_ENTRIES;
  const entries = new Map<string, Entry>();

  async function lookup<R extends WorkspaceRole | SessionRole>(
    key: string,
    fields: Omit<Entry, 'role' | 'expiresAt'>,
    load: () => Promise<R | null>,
  ): Promise<R | null> {
    const hit = entries.get(key);
    if (hit !== undefined && hit.expiresAt > now()) return hit.role as R | null;
    entries.delete(key);
    const role = await load();
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) entries.delete(oldest.value);
    }
    entries.set(key, { ...fields, role, expiresAt: now() + ttlMs });
    return role;
  }

  return {
    workspaceRole: (userId, workspaceId) =>
      lookup(`w|${userId}|${workspaceId}`, { userId, workspaceId }, async () => {
        const role = await inner.workspaceRole(userId, workspaceId);
        return isWorkspaceRole(role) ? role : null;
      }),
    sessionRole: (userId, sessionId) =>
      lookup(`s|${userId}|${sessionId}`, { userId, sessionId }, async () => {
        const role = await inner.sessionRole(userId, sessionId);
        return isSessionRole(role) ? role : null;
      }),
    invalidate(target = {}) {
      for (const [key, entry] of entries) {
        if (
          (target.userId === undefined || target.userId === entry.userId) &&
          (target.workspaceId === undefined || target.workspaceId === entry.workspaceId) &&
          (target.sessionId === undefined || target.sessionId === entry.sessionId)
        ) {
          entries.delete(key);
        }
      }
    },
    size: () => entries.size,
  };
}

const parseInvalidation = (message: string): Invalidation => {
  try {
    const value = JSON.parse(message) as unknown;
    if (typeof value !== 'object' || value === null) return {};
    const { userId, workspaceId, sessionId } = value as Record<string, unknown>;
    return {
      ...(typeof userId === 'string' ? { userId } : {}),
      ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    };
  } catch {
    // An unreadable message drops everything: stale is worse than a few extra queries.
    return {};
  }
};

/** Applies `rbac:invalidate` messages to `reader` until the returned function is called. */
export function subscribeInvalidations(
  pubsub: PubSub,
  reader: Pick<CachedMembershipReader, 'invalidate'>,
): Promise<Unsubscribe> {
  return pubsub.subscribe(RBAC_INVALIDATE_CHANNEL, (message) =>
    reader.invalidate(parseInvalidation(message)),
  );
}

/** Tells every instance to drop cached roles matching `target` (call after changing a membership). */
export function publishInvalidation(pubsub: PubSub, target: Invalidation): Promise<void> {
  return pubsub.publish(RBAC_INVALIDATE_CHANNEL, JSON.stringify(target));
}

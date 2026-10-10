/**
 * The quota state flag (B076): Redis hash `quota:state:{wsp}`, one field per metered limit
 * (`hosted_minutes_month`, `queue_items_month`) holding `ok`, `warn` or `reached`, expiring an hour
 * after the period ends. B080 and the relay's approval and agent-spawn checks read it without SQL.
 *
 * It is a cache: `quota_signal_state` is authoritative. Evaluations replace the hash (`write`);
 * `QuotaSignals.getQuotaState` rebuilds it from SQL when it is missing or unreadable, but only if
 * it is still missing when written (`fill`), so an older SQL reading never replaces the hash of a
 * decision that wrote it meanwhile. This file holds the port and its in-memory twin; the Redis
 * implementation is the worker's `createRedisQuotaStateCache` (DEL, HSET and PEXPIREAT in one
 * MULTI; a Lua script for `fill`; HGETALL), on a client with the deployment's key prefix.
 *
 * Owns: the key and the field values. Must not: hold anything but the levels.
 */
import type { MeteredKey, QuotaLevel } from './levels.js';

/** The hash of a workspace (`quota:state:{wsp}`). */
export const quotaStateKey = (workspaceId: string): string => `quota:state:${workspaceId}`;

/** How long the hash outlives its period. */
export const QUOTA_STATE_GRACE_MS = 60 * 60 * 1000;

/** The levels of every metered limit. */
export type QuotaStateLevels = Record<MeteredKey, QuotaLevel>;

/** The cache. */
export interface QuotaStateCache {
  /** Replaces the workspace's levels; they expire at `expiresAt`. */
  write(workspaceId: string, levels: QuotaStateLevels, expiresAt: Date): Promise<void>;
  /** Writes the levels only if the workspace has none stored; true when it wrote them. */
  fill(workspaceId: string, levels: QuotaStateLevels, expiresAt: Date): Promise<boolean>;
  /** The stored levels (fields not ok/warn/reached left out), or null when there are none. */
  read(workspaceId: string): Promise<Partial<QuotaStateLevels> | null>;
  /** Forgets the workspace's levels (readers then go to SQL). */
  drop(workspaceId: string): Promise<void>;
}

const LEVELS: ReadonlySet<string> = new Set(['ok', 'warn', 'reached']);

/** The fields of a stored hash that are levels. */
export function parseQuotaState(fields: Record<string, string>): Partial<QuotaStateLevels> | null {
  const levels: Partial<QuotaStateLevels> = {};
  for (const key of ['hosted_minutes_month', 'queue_items_month'] as const) {
    const value = fields[key];
    if (value !== undefined && LEVELS.has(value)) levels[key] = value as QuotaLevel;
  }
  return Object.keys(levels).length === 0 ? null : levels;
}

/** The cache in one process (tests, local runs): a map with expiry on `clock`. */
export function memoryQuotaStateCache(clock: () => number = Date.now) {
  const entries = new Map<string, { fields: Record<string, string>; expiresAt: number }>();
  const cache: QuotaStateCache = {
    write(workspaceId, levels, expiresAt) {
      entries.set(quotaStateKey(workspaceId), {
        fields: { ...levels },
        expiresAt: expiresAt.getTime(),
      });
      return Promise.resolve();
    },
    fill(workspaceId, levels, expiresAt) {
      const entry = entries.get(quotaStateKey(workspaceId));
      if (entry !== undefined && entry.expiresAt > clock()) return Promise.resolve(false);
      entries.set(quotaStateKey(workspaceId), {
        fields: { ...levels },
        expiresAt: expiresAt.getTime(),
      });
      return Promise.resolve(true);
    },
    read(workspaceId) {
      const entry = entries.get(quotaStateKey(workspaceId));
      if (entry === undefined || entry.expiresAt <= clock()) return Promise.resolve(null);
      return Promise.resolve(parseQuotaState(entry.fields));
    },
    drop(workspaceId) {
      entries.delete(quotaStateKey(workspaceId));
      return Promise.resolve();
    },
  };
  return { cache, entries };
}

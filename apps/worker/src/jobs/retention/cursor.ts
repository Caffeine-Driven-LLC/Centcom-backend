/**
 * Where a policy's next run continues (B090). The history and audit policies go through the
 * workspaces in id order, deciding and then acting. A run whose budget runs out before it has
 * finished them all leaves the last workspace it finished here (`retention:cursor:<policy>`,
 * B009's `KeyValue`, under the deployment's key prefix). The next run starts after it and wraps
 * around to the first id, so every workspace gets its turn however many there are; a run that
 * goes all the way round clears it.
 *
 * The cursor is a position, not a promise: lost (expired, Redis flushed, unreadable), the next run
 * starts at the first id, which only delays the workspaces after it. A dry run reads it and never
 * moves it.
 *
 * Owns: the key and the walk. Must not: hold anything but a workspace id.
 */
import { isId } from '@centcom/contracts';
import type { KeyValue, Logger } from '@centcom/core';

/** How long a cursor outlives the run that wrote it (then the next run starts at the first id). */
export const RETENTION_CURSOR_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** The cursor's key. */
export const retentionCursorKey = (policy: string): string => `retention:cursor:${policy}`;

/** Where each policy's next run continues. */
export interface DecideCursor {
  /** The workspace id the policy's next run starts after, or null for the first. */
  get(policy: string): Promise<string | null>;
  /** Records where the next run starts after; null clears it. */
  set(policy: string, after: string | null): Promise<void>;
}

/** The cursor on `kv`. */
export function createDecideCursor(
  kv: Pick<KeyValue, 'get' | 'set' | 'del'>,
  options: { ttlMs?: number } = {},
): DecideCursor {
  const ttlMs = options.ttlMs ?? RETENTION_CURSOR_TTL_MS;
  return {
    get: (policy) => kv.get(retentionCursorKey(policy)),
    async set(policy, after) {
      if (after === null) await kv.del(retentionCursorKey(policy));
      else await kv.set(retentionCursorKey(policy), after, { ttlMs });
    },
  };
}

const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

/** Where the policy's run starts after: null when there is no cursor, or it is unreadable. */
export async function readCursor(
  cursor: DecideCursor,
  policy: string,
  logger?: Logger,
): Promise<string | null> {
  try {
    const after = await cursor.get(policy);
    return isId('wsp', after) ? after : null;
  } catch (err) {
    logger?.warn({ policy, step: 'read', error: errorKind(err) }, 'retention.cursor_failed');
    return null;
  }
}

/** Records where the next run starts after; a failure is logged (the next run starts earlier). */
export async function writeCursor(
  cursor: DecideCursor,
  policy: string,
  after: string | null,
  logger?: Logger,
): Promise<void> {
  try {
    await cursor.set(policy, after);
  } catch (err) {
    logger?.warn({ policy, step: 'write', error: errorKind(err) }, 'retention.cursor_failed');
  }
}

/**
 * Every workspace `page(after, limit)` lists, once, in its order: those after `start`, then from
 * the first id round to `start` again. The wrap stops at the first id already given, so it ends
 * whatever the database's collation (or when `start` was deleted).
 */
export async function* workspacesFrom(
  page: (after: string | null, limit: number) => Promise<string[]>,
  start: string | null,
  limit: number,
): AsyncGenerator<string> {
  const given = new Set<string>();
  let after = start;
  for (;;) {
    const ids = await page(after, limit);
    for (const id of ids) {
      given.add(id);
      yield id;
    }
    if (ids.length < limit) break;
    after = ids.at(-1) ?? null;
  }
  if (start === null) return;
  after = null;
  for (;;) {
    const ids = await page(after, limit);
    for (const id of ids) {
      if (given.has(id)) return;
      given.add(id);
      yield id;
    }
    if (ids.length < limit) return;
    after = ids.at(-1) ?? null;
  }
}

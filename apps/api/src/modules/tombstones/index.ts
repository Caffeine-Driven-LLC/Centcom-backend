/**
 * The deletion tombstone log (B099 follow-up): when a workspace is purged, one small object is written to the
 * object store, outside the database. A restore from an older backup brings deleted workspaces back;
 * `applyTombstones` reads the log and deletes them again, so a restore does not resurrect what a customer
 * asked to delete.
 *
 * - A tombstone is `tombstones/workspace/<wsp_id>.json`: `{v, kind, id, deleted_at}`. It holds an opaque id and a
 *   time, nothing else (no name, no e-mail address). It is written by the first workspace purge hook, before any
 *   data is destroyed, and again (same key) on a retry.
 * - `applyTombstones` marks each tombstoned workspace that exists in the (restored) database as deleted and
 *   runs the normal purge on it (hooks, then the rows). A workspace that is not there is already gone.
 * - Accounts are not covered: the account deletion flow is not wired into the running API yet (see
 *   docs/ops/backup-and-dr.md), so there is nothing to record.
 *
 * Owns: the log format, the purge hook and the re-application. Must not: log or return anything but ids and
 * counts, or purge a workspace the log does not name.
 */
import { isId } from '@centcom/contracts';
import type { Logger } from '@centcom/core';
import type { BlobStore } from '@centcom/storage';
import { sql, type Kysely } from 'kysely';

/** What a tombstone says. */
export interface Tombstone {
  kind: 'workspace' | 'account';
  id: string;
  deletedAt: Date;
}

/** Where tombstones are kept. */
export interface TombstoneLog {
  /** Records `id` as deleted at `at`; idempotent. */
  record(tombstone: Tombstone): Promise<void>;
  /** Every tombstone; `unreadable` counts objects that were not valid tombstones (they are ignored). */
  list(): Promise<{ tombstones: Tombstone[]; unreadable: number }>;
}

/** The prefix of the workspace tombstones in the object store. */
export const TOMBSTONE_PREFIX = 'tombstones/workspace/';
/** The prefix of the account tombstones. */
export const ACCOUNT_TOMBSTONE_PREFIX = 'tombstones/account/';
const KEY = /^tombstones\/(workspace|account)\/((?:wsp|usr)_[0-9A-HJKMNP-TV-Z]{26})\.json$/;

export const tombstoneKey = (workspaceId: string): string => {
  if (!isId('wsp', workspaceId)) throw new TypeError('tombstoneKey: not a wsp_ id');
  return `${TOMBSTONE_PREFIX}${workspaceId}.json`;
};

/** The key of an account's tombstone. */
export const accountTombstoneKey = (userId: string): string => {
  if (!isId('usr', userId)) throw new TypeError('accountTombstoneKey: not a usr_ id');
  return `${ACCOUNT_TOMBSTONE_PREFIX}${userId}.json`;
};

const keyOf = (t: Pick<Tombstone, 'kind' | 'id'>): string =>
  t.kind === 'account' ? accountTombstoneKey(t.id) : tombstoneKey(t.id);

/** The log in an object store (S3/R2/MinIO in production, memory in tests). */
export function blobTombstoneLog(blobs: BlobStore): TombstoneLog {
  return {
    async record(t) {
      const body = JSON.stringify({
        v: 1,
        kind: t.kind,
        id: t.id,
        deleted_at: t.deletedAt.toISOString(),
      });
      await blobs.put(keyOf(t), new TextEncoder().encode(body), {
        contentType: 'application/json',
      });
    },
    async list() {
      const out: Tombstone[] = [];
      let unreadable = 0;
      const keys = [
        ...(await blobs.list(TOMBSTONE_PREFIX)),
        ...(await blobs.list(ACCOUNT_TOMBSTONE_PREFIX)),
      ];
      for (const key of keys) {
        const match = KEY.exec(key);
        const kind = match?.[1] as Tombstone['kind'] | undefined;
        const id = match?.[2];
        if (kind === undefined || id === undefined) {
          unreadable += 1;
          continue;
        }
        try {
          const parsed = JSON.parse(new TextDecoder().decode(await blobs.get(key))) as Record<
            string,
            unknown
          >;
          const at = new Date(String(parsed['deleted_at']));
          if (
            parsed['v'] !== 1 ||
            parsed['kind'] !== kind ||
            parsed['id'] !== id ||
            Number.isNaN(at.getTime())
          ) {
            throw new Error('not a tombstone');
          }
          out.push({ kind, id, deletedAt: at });
        } catch {
          unreadable += 1;
        }
      }
      return { tombstones: out, unreadable };
    },
  };
}

/** The name of the purge hook. */
export const TOMBSTONE_HOOK = 'tombstone';

/** Registers the hook that records the tombstone. Register it before every other hook. */
export function registerTombstoneHook(
  registry: {
    register(
      name: string,
      hook: (workspaceId: string, ctx: { now: number }) => Promise<void>,
    ): void;
  },
  log: Pick<TombstoneLog, 'record'>,
): void {
  registry.register(TOMBSTONE_HOOK, (workspaceId, ctx) =>
    log.record({ kind: 'workspace', id: workspaceId, deletedAt: new Date(ctx.now) }),
  );
}

/** What re-applying the log did. */
export interface ApplyReport {
  /** Tombstones in the log. */
  tombstones: number;
  /** Objects in the log that were not tombstones. */
  unreadable: number;
  /** Tombstoned workspaces that were in the database and were purged again. */
  purged: string[];
  /** Tombstoned workspaces that were not in the database (nothing to do). */
  absent: number;
  /** With `dryRun`: the ids that would be purged. */
  wouldPurge: string[];
  /** Tombstoned accounts that the database held and the account purge deleted or scrubbed again. */
  accountsPurged: string[];
  /** Tombstoned accounts that were not in the database, or were already deleted. */
  accountsAbsent: number;
  /** Tombstoned accounts the purge could not finish (it blocked or is waiting); run it again after a look. */
  accountsPending: string[];
  /** With `dryRun`: the account ids that would be purged. */
  accountsWouldPurge: string[];
}

export interface ApplyDeps {
  db: Kysely<{
    workspaces: { id: string; deleted_at: Date | null };
    users: { id: string; status: string; deletion_scheduled_at: Date | null };
  }>;
  log: Pick<TombstoneLog, 'list'>;
  /** The worker's purge for one workspace (hooks, then the rows). */
  purge(workspaceId: string): Promise<{ purged: boolean }>;
  /**
   * The account purge for one user (`purgeUser` over the restored database, with its deadline already passed).
   * Without it, account tombstones are counted and left alone.
   */
  purgeAccount?(userId: string): Promise<'deleted' | 'scrubbed' | 'waiting' | 'blocked' | string>;
  dryRun?: boolean;
  logger?: Logger;
}

/**
 * Deletes again every workspace the log names that the database holds. Marks it deleted (so the purge accepts
 * it) and purges it. Re-running does nothing more: a purged workspace is no longer there.
 */
export async function applyTombstones(deps: ApplyDeps): Promise<ApplyReport> {
  const { tombstones, unreadable } = await deps.log.list();
  const report: ApplyReport = {
    tombstones: tombstones.length,
    unreadable,
    purged: [],
    absent: 0,
    wouldPurge: [],
    accountsPurged: [],
    accountsAbsent: 0,
    accountsPending: [],
    accountsWouldPurge: [],
  };
  for (const t of tombstones) {
    if (t.kind === 'account') {
      await applyAccount(deps, t, report);
      continue;
    }
    const row = await deps.db
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', t.id)
      .executeTakeFirst();
    if (row === undefined) {
      report.absent += 1;
      continue;
    }
    if (deps.dryRun === true) {
      report.wouldPurge.push(t.id);
      continue;
    }
    await deps.db
      .updateTable('workspaces')
      .set({ deleted_at: sql<Date>`coalesce(deleted_at, ${t.deletedAt})` })
      .where('id', '=', t.id)
      .execute();
    const { purged } = await deps.purge(t.id);
    if (purged) report.purged.push(t.id);
    deps.logger?.info({ workspace_id: t.id, purged }, 'tombstones.applied');
  }
  return report;
}

/** Puts one tombstoned account back through the account purge, if the database holds it undeleted. */
async function applyAccount(deps: ApplyDeps, t: Tombstone, report: ApplyReport): Promise<void> {
  const row = await deps.db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('id', '=', t.id)
    .executeTakeFirst();
  if (row === undefined || row.status === 'deleted') {
    report.accountsAbsent += 1;
    return;
  }
  if (deps.purgeAccount === undefined) return;
  if (deps.dryRun === true) {
    report.accountsWouldPurge.push(t.id);
    return;
  }
  // The restored row may be active; the purge only takes users who are pending deletion and due, so make it so
  // (the tombstone's time is the moment the purge ran, which is in the past by definition).
  await deps.db
    .updateTable('users')
    .set({
      status: 'pending_deletion',
      deletion_scheduled_at: sql<Date>`least(coalesce(deletion_scheduled_at, ${t.deletedAt}), ${t.deletedAt})`,
    })
    .where('id', '=', t.id)
    .where('status', '<>', 'deleted')
    .execute();
  const outcome = await deps.purgeAccount(t.id);
  if (outcome === 'deleted' || outcome === 'scrubbed') report.accountsPurged.push(t.id);
  else report.accountsPending.push(t.id);
  deps.logger?.info({ user_id: t.id, outcome }, 'tombstones.account_applied');
}

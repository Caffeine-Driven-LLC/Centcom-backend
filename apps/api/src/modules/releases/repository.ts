/**
 * The releases' SQL (B084): `releases` (each manifest exactly as published) and
 * `release_artifacts`.
 *
 * - `loadActive` reads every channel's active releases, yanked ones included (the cache decides
 *   what is served).
 * - `insert` takes the channel's lock (a transaction-scoped advisory lock), runs the caller's check
 *   against the channel's active releases (no downgrade), writes the release and its artifacts,
 *   and marks all but the newest `keep` of the channel `superseded`, in one transaction.
 * - `yank` sets `yanked_at` and the reason once; the row and its manifest stay.
 *
 * Owns: these statements. Must not: change a stored manifest's text.
 */
import type { ReleaseChannel, ReleaseDatabase } from '@centcom/db';
import { withTransaction } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import type { ReleaseArtifact } from './manifest.js';

/** A stored release. */
export interface StoredRelease {
  channel: ReleaseChannel;
  version: string;
  releasedAt: Date;
  minSupported: string;
  /** The manifest exactly as published. */
  manifest: string;
  manifestSha256: string;
  yankedAt: Date | null;
}

/** A release to store. */
export interface NewRelease {
  channel: ReleaseChannel;
  version: string;
  releasedAt: Date;
  minSupported: string;
  manifest: string;
  manifestSha256: string;
  publishedBy: string;
}

/** How `insert` keeps the channel in order. */
export interface InsertOptions {
  /** Active releases kept per channel. */
  keep: number;
  /** Newest first. */
  order: (a: StoredRelease, b: StoredRelease) => number;
  /** Runs under the channel's lock with its active releases; throws to refuse the release. */
  check(active: readonly StoredRelease[]): void;
}

/** What a yank did. */
export type YankOutcome = 'yanked' | 'already_yanked' | 'missing';

/** The releases' persistence. */
export interface ReleaseRepository {
  /** Every active release of every channel, yanked ones included. */
  loadActive(): Promise<StoredRelease[]>;
  /** One release, or null. */
  get(channel: ReleaseChannel, version: string): Promise<StoredRelease | null>;
  /** Stores a release and its artifacts; returns the versions it superseded. */
  insert(
    release: NewRelease,
    artifacts: readonly ReleaseArtifact[],
    opts: InsertOptions,
  ): Promise<string[]>;
  /** Yanks a release with a reason (at most 200 characters). */
  yank(channel: ReleaseChannel, version: string, reason: string, at: Date): Promise<YankOutcome>;
}

const COLUMNS = [
  'channel',
  'version',
  'released_at',
  'min_supported',
  'manifest',
  'manifest_sha256',
  'yanked_at',
] as const;

type Row = {
  channel: ReleaseChannel;
  version: string;
  released_at: Date;
  min_supported: string;
  manifest: string;
  manifest_sha256: string;
  yanked_at: Date | null;
};

const stored = (r: Row): StoredRelease => ({
  channel: r.channel,
  version: r.version,
  releasedAt: r.released_at,
  minSupported: r.min_supported,
  manifest: r.manifest,
  manifestSha256: r.manifest_sha256,
  yankedAt: r.yanked_at,
});

/** The repository over Postgres. */
export function createReleaseRepository(db: Kysely<ReleaseDatabase>): ReleaseRepository {
  return {
    async loadActive() {
      const rows = await db
        .selectFrom('releases')
        .select(COLUMNS)
        .where('status', '=', 'active')
        .execute();
      return rows.map(stored);
    },

    async get(channel, version) {
      const row = await db
        .selectFrom('releases')
        .select(COLUMNS)
        .where('channel', '=', channel)
        .where('version', '=', version)
        .executeTakeFirst();
      return row === undefined ? null : stored(row);
    },

    insert(release, artifacts, opts) {
      return withTransaction(db, async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`releases:${release.channel}`}))`.execute(
          trx,
        );
        const active = (
          await trx
            .selectFrom('releases')
            .select(COLUMNS)
            .where('channel', '=', release.channel)
            .where('status', '=', 'active')
            .execute()
        ).map(stored);
        opts.check(active);
        await trx
          .insertInto('releases')
          .values({
            channel: release.channel,
            version: release.version,
            released_at: release.releasedAt,
            min_supported: release.minSupported,
            manifest: release.manifest,
            manifest_sha256: release.manifestSha256,
            published_by: release.publishedBy,
          })
          .execute();
        await trx
          .insertInto('release_artifacts')
          .values(
            artifacts.map((a) => ({
              channel: release.channel,
              version: release.version,
              platform: a.platform,
              arch: a.arch,
              kind: a.kind ?? 'binary',
              url: a.url,
              sha256: a.sha256,
              size: a.size,
              sig: a.sig,
              sig_kid: a.sig_kid ?? null,
            })),
          )
          .execute();
        const all = [...active, { ...release, yankedAt: null }].sort(opts.order);
        const superseded = all.slice(opts.keep).map((r) => r.version);
        if (superseded.length > 0) {
          await trx
            .updateTable('releases')
            .set({ status: 'superseded' })
            .where('channel', '=', release.channel)
            .where('version', 'in', superseded)
            .execute();
        }
        return superseded;
      });
    },

    async yank(channel, version, reason, at) {
      const done = await db
        .updateTable('releases')
        .set({ yanked_at: at, yank_reason: reason })
        .where('channel', '=', channel)
        .where('version', '=', version)
        .where('yanked_at', 'is', null)
        .executeTakeFirst();
      if (Number(done.numUpdatedRows) > 0) return 'yanked';
      return (await this.get(channel, version)) === null ? 'missing' : 'already_yanked';
    },
  };
}

/**
 * The minimum client version (B084, CT-STATUS `min_client_version`): the stable channel's latest
 * release's `min_supported`, kept in Redis under `status:min_client_version` for the status feed
 * (B086) and client-too-old checks (B038).
 *
 * - Publishing or yanking a stable release writes the key at once.
 * - `MinClientVersionSync` reads it from Postgres and writes it every 30 s, so a write that failed
 *   (Redis down) is retried and the key always settles on the database's answer. Beta and nightly
 *   releases never move it.
 *
 * Owns: the key. Must not: write anything but a version from a stored, unyanked stable release.
 */
import { MAX_TTL_MS, noopMetrics, type KeyValue, type Logger, type Metrics } from '@centcom/core';
import { parseSemver } from '../flags/version.js';
import { releaseOrder } from './manifest.js';
import type { StoredRelease } from './repository.js';

/** The Redis key (CT-STATUS). */
export const MIN_CLIENT_VERSION_KEY = 'status:min_client_version';
/** How often the key is reconciled with Postgres. */
export const MIN_VERSION_SYNC_MS = 30_000;
/** Every Redis key expires (B009): this one after the longest TTL; the sync rewrites it if missing. */
export const MIN_VERSION_TTL_MS = MAX_TTL_MS;

/** The stable channel's minimum client version among `rows`, or null without a stable release. */
export function stableMinClientVersion(rows: readonly StoredRelease[]): string | null {
  const order = releaseOrder('stable');
  const live = rows
    .filter((r) => r.channel === 'stable' && r.yankedAt === null)
    .map((r) => ({ row: r, version: parseSemver(r.version), releasedAt: r.releasedAt }))
    .filter((r) => r.version !== null && parseSemver(r.row.minSupported) !== null)
    .sort((a, b) =>
      order(
        { version: a.version as NonNullable<typeof a.version>, releasedAt: a.releasedAt },
        { version: b.version as NonNullable<typeof b.version>, releasedAt: b.releasedAt },
      ),
    );
  return live[0]?.row.minSupported ?? null;
}

/** What the sync needs. */
export interface MinVersionSyncDeps {
  /** Every active release (the repository's `loadActive`). */
  load(): Promise<StoredRelease[]>;
  kv: Pick<KeyValue, 'get' | 'set'>;
  /** Default MIN_VERSION_SYNC_MS. */
  intervalMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Keeps `status:min_client_version` equal to Postgres's answer. */
export class MinClientVersionSync {
  readonly #metrics: Metrics;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: MinVersionSyncDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Writes the key when it differs from Postgres's answer; false when that failed. Never throws. */
  async sync(): Promise<boolean> {
    try {
      const version = stableMinClientVersion(await this.deps.load());
      if (version === null) return true;
      if ((await this.deps.kv.get(MIN_CLIENT_VERSION_KEY)) === version) return true;
      await this.deps.kv.set(MIN_CLIENT_VERSION_KEY, version, { ttlMs: MIN_VERSION_TTL_MS });
      this.deps.logger?.info({ min_client_version: version }, 'releases.min_client_version_set');
      return true;
    } catch (err) {
      this.#metrics.counter('releases_min_version_sync_failures_total').inc();
      this.deps.logger?.warn({ error: (err as Error).name }, 'releases.min_version_sync_failed');
      return false;
    }
  }

  /** Syncs every `intervalMs`. */
  start(): void {
    this.#timer ??= setInterval(
      () => void this.sync(),
      this.deps.intervalMs ?? MIN_VERSION_SYNC_MS,
    );
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

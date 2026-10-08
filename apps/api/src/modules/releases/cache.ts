/**
 * What each API process serves (B084): every channel's active, unyanked releases, read from
 * Postgres every 30 s and on each `releases:inv` announcement, with the answers built ahead.
 *
 * - **Latest:** for a platform and arch, the newest release of the channel with an artifact for
 *   them (by version for stable and beta, prerelease order per SemVer; by `released_at` for
 *   nightly). The body is that manifest with only those artifacts, and `min_client_version` (its
 *   `min_supported`) added.
 * - **Manifest:** the channel's newest release, its manifest text served as published.
 * - Every answer carries an ETag of its bytes.
 * - **Corrupt rows:** a stored manifest that no longer parses or matches the schema is skipped
 *   (`releases_corrupt_total`), so the previous release is served.
 * - **Postgres down:** the last good set is served until two refreshes have been missed (60 s);
 *   then `answer` throws 503 with `retry_after_s`.
 *
 * Owns: freshness and the bytes served. Must not: serve a yanked release as latest.
 */
import { createHash } from 'node:crypto';
import { validate } from '@centcom/contracts';
import { noopMetrics, unavailable, type Logger, type Metrics, type PubSub } from '@centcom/core';
import type { ReleaseChannel } from '@centcom/db';
import { parseSemver, type Semver } from '../flags/version.js';
import {
  ARCHS,
  CHANNELS,
  PLATFORMS,
  releaseOrder,
  type Arch,
  type Platform,
  type ReleaseManifest,
} from './manifest.js';
import type { ReleaseRepository, StoredRelease } from './repository.js';

/** The channel releases are announced on: `{"channel": "stable"}`. */
export const RELEASES_CHANNEL = 'releases:inv';
/** How often each process reloads. */
export const RELEASES_REFRESH_MS = 30_000;
/** How long the last good set is served while Postgres cannot be read. */
export const RELEASES_STALE_MS = 2 * RELEASES_REFRESH_MS;
/** `retry_after_s` of a 503. */
export const RELEASES_RETRY_AFTER_S = 5;

/** An answer: its exact bytes and their ETag. */
export interface Served {
  body: string;
  etag: string;
}

/** A served release. */
export interface LiveRelease {
  channel: ReleaseChannel;
  version: string;
  semver: Semver;
  releasedAt: Date;
  minSupported: string;
  manifest: ReleaseManifest;
  text: string;
}

/** What one channel serves. */
export interface ChannelView {
  /** Newest first; never a yanked or corrupt release. */
  releases: readonly LiveRelease[];
  manifest: Served | null;
  /** By `<platform>/<arch>`. */
  latest: ReadonlyMap<string, Served>;
}

/** Every channel. */
export type Catalog = ReadonlyMap<ReleaseChannel, ChannelView>;

/** The ETag of `body`: `"r<22 base64url characters of its sha256>"`. */
export const releaseEtag = (body: string): string =>
  `"r${createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 22)}"`;

const served = (body: string): Served => ({ body, etag: releaseEtag(body) });

/** The `latest` body of `release` for one platform and arch, or null when it has no artifact. */
function latestBody(release: LiveRelease, platform: Platform, arch: Arch): string | null {
  const artifacts = release.manifest.artifacts.filter(
    (a) => a.platform === platform && a.arch === arch,
  );
  if (artifacts.length === 0) return null;
  const { channel, version, released_at, min_supported, notes_url, contract_version, rollout_pct } =
    release.manifest;
  return JSON.stringify({
    channel,
    version,
    released_at,
    min_supported,
    min_client_version: min_supported,
    ...(notes_url === undefined ? {} : { notes_url }),
    ...(contract_version === undefined ? {} : { contract_version }),
    ...(rollout_pct === undefined ? {} : { rollout_pct }),
    artifacts,
  });
}

/** Builds what a channel serves from its stored rows; returns the view and how many were corrupt. */
export function channelView(
  channel: ReleaseChannel,
  rows: readonly StoredRelease[],
): { view: ChannelView; corrupt: number } {
  let corrupt = 0;
  const live: LiveRelease[] = [];
  for (const row of rows) {
    if (row.channel !== channel || row.yankedAt !== null) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      corrupt += 1;
      continue;
    }
    const semver = parseSemver(row.version);
    const checked = validate('release-manifest', manifest);
    if (
      !checked.ok ||
      semver === null ||
      (manifest as ReleaseManifest).version !== row.version ||
      (manifest as ReleaseManifest).channel !== channel
    ) {
      corrupt += 1;
      continue;
    }
    live.push({
      channel,
      version: row.version,
      semver,
      releasedAt: row.releasedAt,
      minSupported: row.minSupported,
      manifest: manifest as ReleaseManifest,
      text: row.manifest,
    });
  }
  const order = releaseOrder(channel);
  live.sort((a, b) =>
    order(
      { version: a.semver, releasedAt: a.releasedAt },
      { version: b.semver, releasedAt: b.releasedAt },
    ),
  );
  const latest = new Map<string, Served>();
  for (const platform of PLATFORMS) {
    for (const arch of ARCHS) {
      for (const release of live) {
        const body = latestBody(release, platform, arch);
        if (body !== null) {
          latest.set(`${platform}/${arch}`, served(body));
          break;
        }
      }
    }
  }
  const newest = live[0];
  return {
    view: { releases: live, manifest: newest === undefined ? null : served(newest.text), latest },
    corrupt,
  };
}

/** What the cache needs. */
export interface ReleaseCacheDeps {
  repository: Pick<ReleaseRepository, 'loadActive'>;
  /** Where `releases:inv` is heard; without it, only the 30 s refresh. */
  pubsub?: Pick<PubSub, 'subscribe'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Default RELEASES_REFRESH_MS. */
  refreshMs?: number;
  /** Default RELEASES_STALE_MS. */
  staleMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The details of refusals (GUIDELINES §3.4). */
export const RELEASE_CACHE_DETAILS = Object.freeze({
  unavailable: 'Release information is unavailable. Try again shortly.',
} as const);

/** Releases, cached per process. */
export class ReleaseCache {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  #catalog: Catalog | null = null;
  #loadedAt = Number.NEGATIVE_INFINITY;
  #failedAt = Number.NEGATIVE_INFINITY;
  #loading: Promise<Catalog> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => Promise<void>) | null = null;

  constructor(private readonly deps: ReleaseCacheDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Subscribes to `releases:inv`, starts refreshing, and loads once (a failure is retried). */
  async start(): Promise<void> {
    if (this.deps.pubsub !== undefined) {
      const unsubscribe = await this.deps.pubsub.subscribe(RELEASES_CHANNEL, () => {
        void this.refresh().catch(() => undefined);
      });
      this.#unsubscribe = async () => {
        await unsubscribe();
      };
    }
    this.#timer = setInterval(
      () => void this.refresh().catch(() => undefined),
      this.deps.refreshMs ?? RELEASES_REFRESH_MS,
    );
    this.#timer.unref();
    await this.refresh().catch(() => undefined);
  }

  /** Stops refreshing and listening. */
  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** The last loaded catalog, however old; null before the first load. */
  current(): Catalog | null {
    return this.#catalog;
  }

  /** The catalog to answer from: fresh enough, or reloaded; 503 when neither is possible. */
  async catalog(): Promise<Catalog> {
    const now = this.#clock();
    const catalog = this.#catalog;
    if (catalog !== null && now - this.#loadedAt <= (this.deps.staleMs ?? RELEASES_STALE_MS)) {
      return catalog;
    }
    const refuse = () =>
      unavailable(RELEASES_RETRY_AFTER_S, RELEASE_CACHE_DETAILS.unavailable, {
        cause: new Error('releases unavailable'),
      });
    // Postgres just failed: answer at once rather than queue requests behind it.
    if (now - this.#failedAt < 1000) throw refuse();
    try {
      return await this.refresh();
    } catch {
      throw refuse();
    }
  }

  /** Reads every channel; concurrent calls share one read. */
  refresh(): Promise<Catalog> {
    this.#loading ??= (async () => {
      try {
        const rows = await this.deps.repository.loadActive();
        const catalog = new Map<ReleaseChannel, ChannelView>();
        let corrupt = 0;
        for (const channel of CHANNELS) {
          const built = channelView(channel, rows);
          catalog.set(channel, built.view);
          corrupt += built.corrupt;
        }
        if (corrupt > 0) {
          this.#metrics.counter('releases_corrupt_total').inc(corrupt);
          this.deps.logger?.error({ corrupt }, 'releases.corrupt_manifest');
        }
        this.#catalog = catalog;
        this.#loadedAt = this.#clock();
        return catalog;
      } catch (err) {
        this.#failedAt = this.#clock();
        this.#metrics.counter('releases_refresh_failures_total').inc();
        this.deps.logger?.warn({ error: (err as Error).name }, 'releases.refresh_failed');
        throw err;
      } finally {
        this.#loading = null;
      }
    })();
    return this.#loading;
  }
}

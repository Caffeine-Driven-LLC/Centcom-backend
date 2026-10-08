/**
 * Publishing and yanking releases (B084). Not reachable over HTTP: the release pipeline calls
 * `publishRelease` through `pnpm release:publish` with a deploy-time database role, and B087's
 * admin tooling may call both with an `admin` credential.
 *
 * Publishing a manifest:
 *
 * 1. checks it (`parseManifest`: the contract schema, fields, versions, HTTPS URLs) and every
 *    artifact's Ed25519 signature against RELEASE_PUBKEYS (`verifySignatures`). Nothing is stored
 *    before both pass; an unsigned manifest never verifies;
 * 2. under the channel's lock, refuses a version that would not become the newest of its channel
 *    (by version for stable and beta, `released_at` for nightly) unless `allowDowngrade`;
 * 3. stores the manifest's exact text and its artifacts, and supersedes all but the newest
 *    RELEASE_KEEP_ACTIVE of the channel;
 * 4. for stable, writes `status:min_client_version` (a failure is left to `MinClientVersionSync`),
 *    and announces the channel on `releases:inv`.
 *
 * Publishing the same version again with the same bytes changes nothing (a retried pipeline);
 * with other bytes it is 409. Yanking keeps the release but takes it out of `latest`.
 *
 * Owns: the publish and yank rules. Must not: make a manifest visible before its signatures verify.
 */
import {
  AppError,
  conflict,
  noopMetrics,
  notFound,
  validationFailed,
  type KeyValue,
  type Logger,
  type Metrics,
  type PubSub,
} from '@centcom/core';
import type { ReleaseChannel } from '@centcom/db';
import { isConnectionError } from '@centcom/db';
import { parseSemver } from '../flags/version.js';
import { RELEASES_CHANNEL } from './cache.js';
import type { ReleasesConfig } from './config.js';
import {
  CHANNELS,
  parseManifest,
  releaseOrder,
  verifySignatures,
  type ParsedManifest,
  type ReleaseManifest,
} from './manifest.js';
import {
  MIN_CLIENT_VERSION_KEY,
  MIN_VERSION_TTL_MS,
  stableMinClientVersion,
} from './min-version.js';
import type { ReleaseRepository, StoredRelease } from './repository.js';

/** Who publishes: a user or API key (admin tooling), or a tool by name (the release pipeline). */
export type ReleaseActor =
  | { kind: 'user'; userId: string }
  | { kind: 'api_key'; keyId: string }
  | { kind: 'system'; name: string };

/** Options of a publish. */
export interface PublishOptions {
  /** The channel the caller means; the manifest's must match. */
  channel?: ReleaseChannel;
  /** Accept a version older than the channel's newest (an admin's decision). */
  allowDowngrade?: boolean;
  /** Check everything, store nothing. */
  dryRun?: boolean;
}

/** What a publish did. */
export interface PublishResult {
  version: string;
  channel: ReleaseChannel;
  /** The same bytes were already published: nothing changed. */
  unchanged?: boolean;
  dryRun?: boolean;
  /** Versions marked superseded. */
  superseded?: string[];
}

/** The details of refusals (GUIDELINES §3.4). */
export const PUBLISH_DETAILS = Object.freeze({
  channelMismatch: 'The manifest is for another channel.',
  downgrade: 'The version is not newer than the channel’s latest release.',
  exists: 'This version is already published with a different manifest.',
  notFound: 'There is no such release.',
  noKeys: 'No release signing keys are configured; nothing can be published.',
  unavailable: 'Releases cannot be changed right now. Try again shortly.',
} as const);

/** The longest yank reason kept. */
export const MAX_YANK_REASON = 200;

/** What the publisher needs. */
export interface ReleasePublisherDeps {
  repository: ReleaseRepository;
  config: ReleasesConfig;
  /** Where `status:min_client_version` lives; without it, only `MinClientVersionSync` writes it. */
  kv?: Pick<KeyValue, 'set'>;
  /** Where `releases:inv` is announced. */
  pubsub?: Pick<PubSub, 'publish'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const actorName = (actor: ReleaseActor): string =>
  actor.kind === 'user' ? actor.userId : actor.kind === 'api_key' ? actor.keyId : actor.name;

const isChannel = (value: unknown): value is ReleaseChannel =>
  typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);

/** Newest first, for stored rows. */
function storedOrder(channel: ReleaseChannel): (a: StoredRelease, b: StoredRelease) => number {
  const order = releaseOrder(channel);
  const key = (r: StoredRelease) => ({
    version: parseSemver(r.version) ?? { major: 0, minor: 0, patch: 0, pre: ['invalid'] },
    releasedAt: r.releasedAt,
  });
  return (a, b) => order(key(a), key(b));
}

/** Publishes and yanks releases. */
export class ReleasePublisher {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: ReleasePublisherDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /**
   * Publishes `manifest` (its text, or an object, which is serialised once and then kept byte for
   * byte). 422 for a manifest that fails a check or a signature, 409 for a version published with
   * other bytes or not newer than the channel's latest.
   */
  async publishRelease(
    manifest: string | ReleaseManifest,
    actor: ReleaseActor,
    opts: PublishOptions = {},
  ): Promise<PublishResult> {
    if (this.deps.config.keys.length === 0) {
      throw new AppError('service_unavailable', { detail: PUBLISH_DETAILS.noKeys });
    }
    const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    const parsed = parseManifest(text, { artifactHosts: this.deps.config.artifactHosts });
    verifySignatures(parsed.manifest, this.deps.config.keys);
    const channel = parsed.manifest.channel;
    if (opts.channel !== undefined && opts.channel !== channel) {
      throw validationFailed(
        [{ pointer: '/channel', code: 'invalid_value', detail: `must be ${opts.channel}` }],
        PUBLISH_DETAILS.channelMismatch,
      );
    }
    const version = parsed.manifest.version;
    const existing = await this.#guarded(() => this.deps.repository.get(channel, version));
    if (existing !== null) {
      if (existing.manifestSha256 === parsed.sha256) return { version, channel, unchanged: true };
      throw conflict(PUBLISH_DETAILS.exists);
    }
    if (opts.dryRun === true) {
      const active = (await this.#guarded(() => this.deps.repository.loadActive())).filter(
        (r) => r.channel === channel,
      );
      this.#checkNewest(parsed, active, opts.allowDowngrade === true);
      return { version, channel, dryRun: true };
    }
    const superseded = await this.#guarded(() =>
      this.deps.repository.insert(
        {
          channel,
          version,
          releasedAt: parsed.releasedAt,
          minSupported: parsed.manifest.min_supported,
          manifest: parsed.text,
          manifestSha256: parsed.sha256,
          publishedBy: actorName(actor),
        },
        parsed.manifest.artifacts,
        {
          keep: this.deps.config.keepActive,
          order: storedOrder(channel),
          check: (active) => this.#checkNewest(parsed, active, opts.allowDowngrade === true),
        },
      ),
    );
    this.#metrics.counter('releases_published_total', { channel }).inc();
    this.deps.logger?.info(
      { channel, version, superseded: superseded.length },
      'releases.published',
    );
    await this.#afterChange(channel);
    return { version, channel, ...(superseded.length > 0 ? { superseded } : {}) };
  }

  /** Takes a release out of `latest`, keeping it; 404 when there is none. */
  async yankRelease(
    version: string,
    channel: ReleaseChannel,
    reason: string,
    actor: ReleaseActor,
  ): Promise<{ version: string; channel: ReleaseChannel; yanked: boolean }> {
    if (!isChannel(channel) || parseSemver(version) === null)
      throw notFound(PUBLISH_DETAILS.notFound);
    const outcome = await this.#guarded(() =>
      this.deps.repository.yank(
        channel,
        version,
        reason.slice(0, MAX_YANK_REASON),
        new Date(this.#clock()),
      ),
    );
    if (outcome === 'missing') throw notFound(PUBLISH_DETAILS.notFound);
    if (outcome === 'yanked') {
      this.deps.logger?.info({ channel, version, by: actor.kind }, 'releases.yanked');
      await this.#afterChange(channel);
    }
    return { version, channel, yanked: outcome === 'yanked' };
  }

  /** Refuses a release that would not be the channel's newest (unless allowed). */
  #checkNewest(
    parsed: ParsedManifest,
    active: readonly StoredRelease[],
    allowDowngrade: boolean,
  ): void {
    if (allowDowngrade) return;
    const channel = parsed.manifest.channel;
    const order = storedOrder(channel);
    const candidate: StoredRelease = {
      channel,
      version: parsed.manifest.version,
      releasedAt: parsed.releasedAt,
      minSupported: parsed.manifest.min_supported,
      manifest: parsed.text,
      manifestSha256: parsed.sha256,
      yankedAt: null,
    };
    const newest = active.filter((r) => r.yankedAt === null).sort(order)[0];
    if (newest !== undefined && order(candidate, newest) >= 0) {
      throw conflict(PUBLISH_DETAILS.downgrade);
    }
  }

  /** The stable key and the announcement; failures are left to the sync job and the refresh. */
  async #afterChange(channel: ReleaseChannel): Promise<void> {
    if (channel === 'stable' && this.deps.kv !== undefined) {
      try {
        const version = stableMinClientVersion(await this.deps.repository.loadActive());
        if (version !== null) {
          await this.deps.kv.set(MIN_CLIENT_VERSION_KEY, version, { ttlMs: MIN_VERSION_TTL_MS });
        }
      } catch (err) {
        this.#metrics.counter('releases_min_version_sync_failures_total').inc();
        this.deps.logger?.warn({ error: (err as Error).name }, 'releases.min_version_write_failed');
      }
    }
    try {
      await this.deps.pubsub?.publish(RELEASES_CHANNEL, JSON.stringify({ channel }));
    } catch (err) {
      this.deps.logger?.warn({ error: (err as Error).name }, 'releases.announce_failed');
    }
  }

  async #guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (isConnectionError(err) || code === '57014') {
        throw new AppError('service_unavailable', {
          detail: PUBLISH_DETAILS.unavailable,
          retryAfterS: 5,
          cause: new Error('database unavailable'),
        });
      }
      throw err;
    }
  }
}

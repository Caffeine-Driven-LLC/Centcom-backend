/**
 * Test helpers for releases (B084): Ed25519 release keys generated per run, signed manifests (the
 * contract schema's shape, artifacts signed over their SHA-256), an in-memory ReleaseRepository
 * with the Postgres one's semantics (a check under the channel's lock, verbatim text, superseding,
 * yanks that keep the row), and the routes on the API's plugin stack with B023's rate limiter.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import {
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  type RedisBackend,
} from '@centcom/core';
import type { ReleaseChannel } from '@centcom/db';
import { fastify, type FastifyInstance } from 'fastify';
import { ReleaseCache } from '../../src/modules/releases/cache.js';
import { loadReleasesConfig, type ReleasesConfig } from '../../src/modules/releases/config.js';
import type { ReleaseArtifact, ReleaseManifest } from '../../src/modules/releases/manifest.js';
import { ReleasePublisher } from '../../src/modules/releases/publisher.js';
import type {
  InsertOptions,
  NewRelease,
  ReleaseRepository,
  StoredRelease,
  YankOutcome,
} from '../../src/modules/releases/repository.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { rateLimitPlugin } from '../../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { releaseRoutes } from '../../src/routes/releases.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** The tests' "now". */
export const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

/** A release signing key pair, and its RELEASE_PUBKEYS entry. */
export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  /** `kid:<base64url>`. */
  entry: string;
}

/** A fresh Ed25519 key pair. */
export function releaseKey(kid = `rel${randomBytes(2).toString('hex')}`): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return { kid, privateKey, entry: `${kid}:${x}` };
}

/** `key`'s signature (base64url) over the digest `sha256` (hex). */
export const signDigest = (key: SigningKey, sha256: string): string =>
  sign(null, Buffer.from(sha256, 'hex'), key.privateKey).toString('base64url');

/** A signed artifact for `platform`/`arch`. */
export function artifact(
  key: SigningKey,
  platform: ReleaseArtifact['platform'] = 'linux',
  arch: ReleaseArtifact['arch'] = 'x64',
  version = '1.0.0',
  over: Partial<ReleaseArtifact> = {},
): ReleaseArtifact {
  const sha256 = createHash('sha256').update(`${version}/${platform}/${arch}`).digest('hex');
  return {
    platform,
    arch,
    kind: 'binary',
    url: `https://dl.centcom.dev/${version}/centcom-${platform}-${arch}`,
    sha256,
    size: 41_234_567,
    sig: signDigest(key, sha256),
    sig_kid: key.kid,
    ...over,
  };
}

/** A manifest for every platform and arch, signed by `key`. */
export function manifest(
  key: SigningKey,
  over: Partial<ReleaseManifest> & { version?: string } = {},
): ReleaseManifest {
  const version = over.version ?? '1.0.0';
  return {
    channel: 'stable',
    version,
    released_at: new Date(T0).toISOString(),
    min_supported: '1.0.0',
    rollout_pct: 100,
    contract_version: '1.0.0',
    artifacts: (['linux', 'darwin', 'win32'] as const).flatMap((p) =>
      (['x64', 'arm64'] as const).map((a) => artifact(key, p, a, version)),
    ),
    ...over,
  };
}

/** The configuration with `keys`. */
export function releasesConfig(keys: readonly SigningKey[], keep = 20): ReleasesConfig {
  return loadReleasesConfig({
    RELEASE_PUBKEYS: keys.map((k) => k.entry).join(','),
    RELEASE_KEEP_ACTIVE: String(keep),
  });
}

/** An in-memory ReleaseRepository. */
export class MemoryReleaseRepository implements ReleaseRepository {
  rows: (StoredRelease & {
    status: 'active' | 'superseded';
    publishedBy: string;
    yankReason: string | null;
  })[] = [];
  artifacts: { channel: string; version: string; artifact: ReleaseArtifact }[] = [];
  /** Every read and write fails (Postgres down). */
  down = false;
  loads = 0;

  #check(): void {
    if (this.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  }

  loadActive(): Promise<StoredRelease[]> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    this.loads += 1;
    return Promise.resolve(this.rows.filter((r) => r.status === 'active').map((r) => ({ ...r })));
  }

  get(channel: ReleaseChannel, version: string): Promise<StoredRelease | null> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const row = this.rows.find((r) => r.channel === channel && r.version === version);
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  insert(
    release: NewRelease,
    artifacts: readonly ReleaseArtifact[],
    opts: InsertOptions,
  ): Promise<string[]> {
    try {
      this.#check();
      const active = this.rows.filter(
        (r) => r.channel === release.channel && r.status === 'active',
      );
      opts.check(active.map((r) => ({ ...r })));
      if (this.rows.some((r) => r.channel === release.channel && r.version === release.version)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const row = { ...release, yankedAt: null, status: 'active' as const, yankReason: null };
      this.rows.push(row);
      for (const a of artifacts)
        this.artifacts.push({ channel: release.channel, version: release.version, artifact: a });
      const ordered = [...active, row].sort(opts.order);
      const superseded = ordered.slice(opts.keep).map((r) => r.version);
      for (const r of this.rows) {
        if (r.channel === release.channel && superseded.includes(r.version))
          r.status = 'superseded';
      }
      return Promise.resolve(superseded);
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }

  yank(channel: ReleaseChannel, version: string, reason: string, at: Date): Promise<YankOutcome> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const row = this.rows.find((r) => r.channel === channel && r.version === version);
    if (row === undefined) return Promise.resolve('missing');
    if (row.yankedAt !== null) return Promise.resolve('already_yanked');
    row.yankedAt = at;
    row.yankReason = reason;
    return Promise.resolve('yanked');
  }
}

/** The routes over a cache, a publisher, and shared state. */
export interface ReleasesApp {
  app: FastifyInstance;
  repo: MemoryReleaseRepository;
  cache: ReleaseCache;
  publisher: ReleasePublisher;
  redis: RedisBackend;
  key: SigningKey;
  clock: { now: number };
  recorded: ReturnType<typeof recordingMetrics>;
  captured: ReturnType<typeof captureLogger>;
}

/** The release routes on the API's stack (request context, errors, rate limit by address). */
export async function releasesApp(
  opts: { rateLimit?: boolean; repo?: MemoryReleaseRepository } = {},
): Promise<ReleasesApp> {
  const key = releaseKey('rel1');
  const repo = opts.repo ?? new MemoryReleaseRepository();
  const clock = { now: T0 };
  const redis = createMemoryRedis(() => clock.now);
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const cache = new ReleaseCache({
    repository: repo,
    pubsub: redis.pubsub,
    clock: () => clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  await cache.start();
  const publisher = new ReleasePublisher({
    repository: repo,
    config: releasesConfig([key]),
    kv: redis.kv,
    pubsub: redis.pubsub,
    clock: () => clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  if (opts.rateLimit === true) {
    await app.register(rateLimitPlugin, {
      store: redis.rateLimit,
      config: { buckets: defaultBuckets, trustedHops: 0, exempt: DEFAULT_EXEMPT_ROUTES },
    });
  }
  await app.register(releaseRoutes, { releases: cache });
  app.addHook('onClose', async () => {
    await cache.stop();
  });
  await app.ready();
  return { app, repo, cache, publisher, redis, key, clock, recorded, captured };
}

/** GET a release URL. */
export function get(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers });
}

/** Resolves once `check` holds, polling every 5 ms; rejects after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > timeoutMs) throw new Error(`not within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

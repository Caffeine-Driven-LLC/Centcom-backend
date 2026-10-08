/**
 * Publishing releases (B084):
 *
 * - a bad signature, an unknown key, a malformed hash or a non-HTTPS URL is refused before anything
 *   is stored; without configured keys nothing can be published;
 * - a version older than the channel's latest is refused (409) unless an admin allows a downgrade;
 *   nightly is ordered by `released_at`;
 * - the same version with the same bytes changes nothing; with other bytes it is 409;
 * - only the newest RELEASE_KEEP_ACTIVE of a channel stay active;
 * - `status:min_client_version` follows the stable channel only; with Redis down the manifest is
 *   stored anyway and the sync job writes the key once Redis is back.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_CLIENT_VERSION_KEY,
  MinClientVersionSync,
} from '../../src/modules/releases/min-version.js';
import { ReleasePublisher } from '../../src/modules/releases/publisher.js';
import {
  artifact,
  manifest,
  MemoryReleaseRepository,
  releaseKey,
  releasesApp,
  releasesConfig,
  signDigest,
  T0,
} from './helpers.js';

const ci = { kind: 'system' as const, name: 'release-cli' };
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

describe('what gets in', () => {
  it('refuses unsigned, tampered, wrong-key, malformed and non-HTTPS manifests before storing', async () => {
    const t = await releasesApp();
    const stranger = releaseKey('rel1');
    const m = manifest(t.key);
    const first = m.artifacts[0] ?? artifact(t.key);
    const bad = [
      { ...m, artifacts: [{ ...first, sig: signDigest(stranger, first.sha256) }] },
      { ...m, artifacts: [{ ...first, sha256: 'd'.repeat(64) }] },
      { ...m, artifacts: [{ ...first, sig_kid: 'rel9' }] },
      { ...m, artifacts: [{ ...first, sha256: 'not-a-hash' }] },
      { ...m, artifacts: [{ ...first, url: 'http://dl.centcom.dev/x' }] },
      { ...m, build: { ci: 'https://ci.internal/123' } },
    ];
    for (const candidate of bad) {
      await expect(t.publisher.publishRelease(JSON.stringify(candidate), ci)).rejects.toMatchObject(
        {
          status: 422,
        },
      );
    }
    expect(t.repo.rows).toEqual([]);
    const keyless = new ReleasePublisher({ repository: t.repo, config: releasesConfig([]) });
    await expect(keyless.publishRelease(JSON.stringify(m), ci)).rejects.toMatchObject({
      status: 503,
    });
    expect(t.repo.rows).toEqual([]);
    await t.app.close();
  });

  it('refuses a downgrade unless allowed, and orders nightly by released_at', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(manifest(t.key, { version: '1.2.0' }), ci);
    for (const version of ['1.1.9', '1.2.0-rc.1']) {
      await expect(
        t.publisher.publishRelease(manifest(t.key, { version }), ci),
      ).rejects.toMatchObject({
        status: 409,
        code: 'conflict',
      });
    }
    expect(
      await t.publisher.publishRelease(manifest(t.key, { version: '1.1.9' }), ci, {
        allowDowngrade: true,
      }),
    ).toEqual({
      version: '1.1.9',
      channel: 'stable',
    });
    expect(
      await t.publisher.publishRelease(
        manifest(t.key, { version: '1.3.0-beta.1', channel: 'beta' }),
        ci,
      ),
    ).toMatchObject({
      channel: 'beta',
    });
    // Nightly: a later build may carry a lower version; an earlier one may not.
    await t.publisher.publishRelease(
      manifest(t.key, { channel: 'nightly', version: '2.0.0-nightly.5', released_at: at(10) }),
      ci,
    );
    await t.publisher.publishRelease(
      manifest(t.key, { channel: 'nightly', version: '2.0.0-nightly.10', released_at: at(20) }),
      ci,
    );
    await expect(
      t.publisher.publishRelease(
        manifest(t.key, { channel: 'nightly', version: '2.0.0-nightly.99', released_at: at(15) }),
        ci,
      ),
    ).rejects.toMatchObject({ status: 409 });
    // A yanked newest no longer blocks.
    await t.publisher.yankRelease('1.2.0', 'stable', 'bad', ci);
    expect(
      (await t.publisher.publishRelease(manifest(t.key, { version: '1.2.0-hotfix' }), ci)).version,
    ).toBe('1.2.0-hotfix');
    await t.app.close();
  });

  it('treats the same bytes again as done, other bytes as a conflict, and checks the channel', async () => {
    const t = await releasesApp();
    const text = JSON.stringify(manifest(t.key));
    await t.publisher.publishRelease(text, ci);
    expect(await t.publisher.publishRelease(text, ci)).toEqual({
      version: '1.0.0',
      channel: 'stable',
      unchanged: true,
    });
    await expect(t.publisher.publishRelease(`${text}\n`, ci)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      t.publisher.publishRelease(manifest(t.key, { version: '1.0.1' }), ci, { channel: 'beta' }),
    ).rejects.toMatchObject({ status: 422 });
    // A dry run stores nothing.
    expect(
      await t.publisher.publishRelease(manifest(t.key, { version: '1.0.2' }), ci, { dryRun: true }),
    ).toEqual({
      version: '1.0.2',
      channel: 'stable',
      dryRun: true,
    });
    expect(t.repo.rows.map((r) => r.version)).toEqual(['1.0.0']);
    await t.app.close();
  });

  it('keeps only the newest RELEASE_KEEP_ACTIVE manifests of a channel active', async () => {
    const key = releaseKey('rel1');
    const repo = new MemoryReleaseRepository();
    const publisher = new ReleasePublisher({ repository: repo, config: releasesConfig([key], 3) });
    for (let patch = 0; patch < 5; patch += 1) {
      await publisher.publishRelease(manifest(key, { version: `1.0.${patch}` }), ci);
    }
    expect(repo.rows.filter((r) => r.status === 'active').map((r) => r.version)).toEqual([
      '1.0.2',
      '1.0.3',
      '1.0.4',
    ]);
    expect(repo.rows.filter((r) => r.status === 'superseded').map((r) => r.version)).toEqual([
      '1.0.0',
      '1.0.1',
    ]);
    // Superseded manifests are kept, not deleted.
    expect(repo.rows).toHaveLength(5);
  });
});

describe('status:min_client_version', () => {
  it('follows the stable channel only', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(
      manifest(t.key, { version: '1.4.0', min_supported: '1.2.0' }),
      ci,
    );
    expect(await t.redis.kv.get(MIN_CLIENT_VERSION_KEY)).toBe('1.2.0');
    await t.publisher.publishRelease(
      manifest(t.key, { channel: 'beta', version: '1.5.0-beta.1', min_supported: '1.5.0-beta.1' }),
      ci,
    );
    await t.publisher.publishRelease(
      manifest(t.key, {
        channel: 'nightly',
        version: '1.6.0-nightly.1',
        min_supported: '1.6.0-nightly.1',
      }),
      ci,
    );
    expect(await t.redis.kv.get(MIN_CLIENT_VERSION_KEY)).toBe('1.2.0');
    await t.publisher.publishRelease(
      manifest(t.key, { version: '1.5.0', min_supported: '1.3.0' }),
      ci,
    );
    expect(await t.redis.kv.get(MIN_CLIENT_VERSION_KEY)).toBe('1.3.0');
    // Yanking the stable latest moves it back.
    await t.publisher.yankRelease('1.5.0', 'stable', 'regression', ci);
    expect(await t.redis.kv.get(MIN_CLIENT_VERSION_KEY)).toBe('1.2.0');
    expect(await t.redis.kv.ttl(MIN_CLIENT_VERSION_KEY)).toBeGreaterThan(30 * 24 * 3600 * 1000);
    await t.app.close();
  });

  it('stores the manifest when Redis is down, and the sync job writes the key later', async () => {
    const t = await releasesApp();
    const set = t.redis.kv.set.bind(t.redis.kv);
    t.redis.kv.set = () => Promise.reject(new Error('redis down'));
    const result = await t.publisher.publishRelease(
      manifest(t.key, { version: '2.0.0', min_supported: '1.8.0' }),
      ci,
    );
    expect(result.version).toBe('2.0.0');
    expect(t.repo.rows.map((r) => r.version)).toEqual(['2.0.0']);
    expect(t.recorded.count('releases_min_version_sync_failures_total')).toBe(1);
    expect(await t.redis.kv.get(MIN_CLIENT_VERSION_KEY)).toBeNull();

    const sync = new MinClientVersionSync({ load: () => t.repo.loadActive(), kv: t.redis.kv });
    expect(await sync.sync()).toBe(false);
    t.redis.kv.set = set;
    expect(await sync.sync()).toBe(true);
    expect(await t.redis.kv.get(MIN_CLIENT_VERSION_KEY)).toBe('1.8.0');
    // Postgres down: the sync fails quietly and retries next time.
    t.repo.down = true;
    expect(await sync.sync()).toBe(false);
    await t.app.close();
  });

  it('answers 503 while Postgres is down, storing nothing', async () => {
    const t = await releasesApp();
    t.repo.down = true;
    await expect(t.publisher.publishRelease(manifest(t.key), ci)).rejects.toMatchObject({
      status: 503,
      retryAfterS: 5,
    });
    await expect(t.publisher.yankRelease('1.0.0', 'stable', 'x', ci)).rejects.toMatchObject({
      status: 503,
    });
    await t.app.close();
  });
});

/**
 * Releases on Postgres 16 (B084; DATABASE_URL, CI's integration job): the repository, the
 * publisher and the CLI over the migrated schema.
 *
 * - a published manifest comes back byte for byte (text, never re-serialised), with its artifacts;
 * - yanks keep the row; superseding keeps the newest RELEASE_KEEP_ACTIVE active;
 * - concurrent publishes to one channel never store a downgrade;
 * - `pnpm release:publish` (runPublishCli) publishes against the database with a deploy role.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleaseDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ReleaseCache } from '../../src/modules/releases/cache.js';
import { PUBLISH_EXIT, runPublishCli } from '../../src/modules/releases/cli.js';
import { ReleasePublisher } from '../../src/modules/releases/publisher.js';
import { createReleaseRepository } from '../../src/modules/releases/repository.js';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
import { manifest, releaseKey, releasesConfig, T0 } from './helpers.js';

const ci = { kind: 'system' as const, name: 'release-cli' };

describe.runIf(ADMIN_URL !== undefined)('releases on Postgres 16', () => {
  it('stores manifests byte for byte, yanks and supersedes without deleting', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<ReleaseDatabase>;
      const repo = createReleaseRepository(db);
      const key = releaseKey('rel1');
      const publisher = new ReleasePublisher({
        repository: repo,
        config: releasesConfig([key], 3),
      });
      const first = `${JSON.stringify(manifest(key, { version: '1.0.0' }), null, 3)}\n`;
      await publisher.publishRelease(first, ci);
      expect((await repo.get('stable', '1.0.0'))?.manifest).toBe(first);
      const artifacts = await db
        .selectFrom('release_artifacts')
        .select(['platform', 'arch', 'kind', 'url', 'size'])
        .where('version', '=', '1.0.0')
        .orderBy('platform')
        .orderBy('arch')
        .execute();
      expect(artifacts).toHaveLength(6);
      expect(artifacts[0]).toMatchObject({
        platform: 'darwin',
        arch: 'arm64',
        kind: 'binary',
        size: '41234567',
      });

      for (const version of ['1.1.0', '1.2.0', '1.3.0']) {
        await publisher.publishRelease(
          manifest(key, { version, released_at: new Date(T0 + 1000).toISOString() }),
          ci,
        );
      }
      const statuses = await db
        .selectFrom('releases')
        .select(['version', 'status'])
        .orderBy('version')
        .execute();
      expect(statuses).toEqual([
        { version: '1.0.0', status: 'superseded' },
        { version: '1.1.0', status: 'active' },
        { version: '1.2.0', status: 'active' },
        { version: '1.3.0', status: 'active' },
      ]);
      expect(await repo.yank('stable', '1.3.0', 'regression', new Date(T0))).toBe('yanked');
      expect(await repo.yank('stable', '1.3.0', 'again', new Date(T0))).toBe('already_yanked');
      expect(await repo.yank('stable', '9.0.0', 'x', new Date(T0))).toBe('missing');

      const cache = new ReleaseCache({ repository: repo });
      const catalog = await cache.refresh();
      expect(catalog.get('stable')?.releases.map((r) => r.version)).toEqual(['1.2.0', '1.1.0']);
      expect(
        JSON.parse(catalog.get('stable')?.latest.get('linux/x64')?.body ?? '{}'),
      ).toMatchObject({ version: '1.2.0' });
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('never stores a downgrade under concurrent publishes to one channel', async () => {
    const t = await migratedDatabase(5);
    try {
      const repo = createReleaseRepository(t.db as unknown as Kysely<ReleaseDatabase>);
      const key = releaseKey('rel1');
      const publisher = new ReleasePublisher({ repository: repo, config: releasesConfig([key]) });
      const results = await Promise.allSettled(
        ['1.1.0', '1.2.0', '1.0.5', '1.3.0'].map((version) =>
          publisher.publishRelease(manifest(key, { version }), ci),
        ),
      );
      const stored = (await repo.loadActive()).map((r) => r.version);
      // Each stored version was the newest when it was stored: in storing order they only rise.
      expect(stored.length).toBe(results.filter((r) => r.status === 'fulfilled').length);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409 });
      }
      expect(stored).toContain('1.3.0');
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('publishes through the CLI with a database role', async () => {
    const t = await migratedDatabase(5);
    const dir = await mkdtemp(join(tmpdir(), 'release-cli-pg-'));
    try {
      const key = releaseKey('rel1');
      const file = join(dir, 'm.json');
      const text = JSON.stringify(manifest(key, { version: '3.0.0', min_supported: '2.0.0' }));
      await writeFile(file, text);
      const out: string[] = [];
      const env = { NODE_ENV: 'test', DATABASE_URL: t.url, RELEASE_PUBKEYS: key.entry };
      const run = (argv: string[]) =>
        runPublishCli(argv, { out: (s) => out.push(s), err: (s) => out.push(s), env });
      expect(await run([file, '--channel', 'stable', '--dry-run'])).toBe(PUBLISH_EXIT.ok);
      expect(await run([file, '--channel', 'stable'])).toBe(PUBLISH_EXIT.ok);
      expect(JSON.parse(out[1] ?? '{}')).toMatchObject({
        ok: true,
        channel: 'stable',
        version: '3.0.0',
      });
      expect(await run([file, '--channel', 'stable'])).toBe(PUBLISH_EXIT.ok);
      expect(JSON.parse(out[2] ?? '{}')).toMatchObject({ ok: true, unchanged: true });
      const repo = createReleaseRepository(t.db as unknown as Kysely<ReleaseDatabase>);
      expect((await repo.get('stable', '3.0.0'))?.manifest).toBe(text);
      expect(out.join('')).not.toContain(t.url);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await t.drop();
    }
  }, 60_000);
});

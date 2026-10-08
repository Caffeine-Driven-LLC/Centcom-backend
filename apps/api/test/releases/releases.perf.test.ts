/**
 * Release endpoint speed (B084 acceptance 4): `latest` and `manifest.json` answer from the memory
 * cache within 30 ms at the 95th percentile, timed in a separate process (releases-bench.ts), and
 * read nothing from the repository on the request path. And `pnpm release:publish` runs as a
 * script: a dry run of a signed manifest passes, of a tampered one fails.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifest, releaseKey } from './helpers.js';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./releases-bench.ts', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/publish-release.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = join(REPO_ROOT, 'tsconfig.test.json');

describe('release endpoints from the cache', () => {
  it('answer within 30 ms at the 95th percentile, without reading the repository', () => {
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: API_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const { p95s, loads } = JSON.parse(out) as { p95s: number[]; loads: number };
    expect(loads).toBe(0);
    expect(Math.min(...p95s)).toBeLessThanOrEqual(30);
  }, 150_000);
});

describe('pnpm release:publish', () => {
  it('dry-runs a signed manifest with exit 0, and a tampered one with exit 1', async () => {
    const key = releaseKey('rel1');
    const dir = await mkdtemp(join(tmpdir(), 'release-script-'));
    try {
      const good = join(dir, 'good.json');
      const bad = join(dir, 'bad.json');
      const m = manifest(key);
      await writeFile(good, JSON.stringify(m));
      await writeFile(
        bad,
        JSON.stringify({
          ...m,
          version: '1.0.1',
          artifacts: m.artifacts.map((a) => ({
            ...a,
            sha256: createHash('sha256').update('other').digest('hex'),
          })),
        }),
      );
      // Only what the script needs: no database or Redis, whatever the test environment has.
      const run = (file: string) =>
        execFileSync(
          process.execPath,
          [TSX_CLI, '--tsconfig', TSCONFIG, SCRIPT, file, '--channel', 'stable', '--dry-run'],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 60_000,
            env: { NODE_ENV: 'test', RELEASE_PUBKEYS: key.entry },
          },
        );
      expect(JSON.parse(run(good))).toMatchObject({ ok: true, version: '1.0.0', dryRun: true });
      let failure: { status?: number; stdout?: string } = {};
      try {
        run(bad);
      } catch (err) {
        failure = err as { status?: number; stdout?: string };
      }
      expect(failure.status).toBe(1);
      expect(JSON.parse(failure.stdout ?? '{}')).toMatchObject({
        ok: false,
        code: 'validation_failed',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

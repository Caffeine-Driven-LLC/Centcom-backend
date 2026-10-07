/**
 * Dev stack smoke test (B012; the card's optional one): `pnpm dev:reset` from scratch, then
 * `pnpm dev:up` again, against real containers. Proves acceptance 1 (healthy and exit 0 within
 * 90 s, images cached), 2 (exactly the seeded rows, migrations at the latest version), 3 (a second
 * up is idempotent) and 4 (reset wipes and reseeds).
 *
 * It WIPES the local dev stack and binds its ports, so it runs only when asked:
 *
 *   CENTCOM_DEV_SMOKE=1 pnpm vitest run --config vitest.workspace.ts tools/dev/smoke.test.ts
 *
 * Not in CI: the integration job's service containers already hold ports 5432 and 6379.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expectedMigrationVersion } from '@centcom/db';
import { afterAll, describe, expect, it } from 'vitest';
import { SEED } from './seed.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ENABLED = process.env.CENTCOM_DEV_SMOKE === '1';
const UP_LIMIT_MS = 90_000;

function run(script: string): { status: number | null; ms: number; output: string } {
  const started = Date.now();
  const result = spawnSync('bash', [join(ROOT, 'tools', 'dev', script)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5 * 60_000,
  });
  return {
    status: result.status,
    ms: Date.now() - started,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

/** Runs SQL in the stack's Postgres container; one line per row, columns joined by `|`. */
function psql(query: string): string[] {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--file',
      join(ROOT, 'infra', 'compose', 'docker-compose.yml'),
      'exec',
      '-T',
      'postgres',
      'psql',
      '--username=centcom',
      '--dbname=centcom_dev',
      '--no-align',
      '--tuples-only',
      '--command',
      query,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split('\n');
}

function expectSeeded(): void {
  expect(psql('select count(*) from users')).toEqual(['3']);
  expect(psql('select role from memberships order by role')).toEqual(['guest', 'member', 'owner']);
  expect(psql('select id, state from sessions')).toEqual([`${SEED.session.id}|paused`]);
  expect(psql('select count(*) from devices')).toEqual(['2']);
  expect(psql('select max(version) from schema_migrations')).toEqual([expectedMigrationVersion()]);
}

describe.runIf(ENABLED)('the local dev stack', () => {
  afterAll(() => {
    run('down.sh');
  });

  it(
    'comes up from scratch within 90 s, seeded (acceptance 1, 2 and 4)',
    () => {
      const reset = run('reset.sh');
      expect(reset.status, reset.output).toBe(0);
      // reset = down --volumes, then up; the limit is on the whole of it.
      expect(reset.ms).toBeLessThan(UP_LIMIT_MS);
      expect(reset.output).toContain('Centcom dev stack is up');
      expectSeeded();
    },
    5 * 60_000,
  );

  it(
    'runs up again without duplicates or errors (acceptance 3)',
    () => {
      psql(`insert into workspaces (id, name, slug, created_by)
          values ('wsp_01KDVDNA00SM0KETEST0000001', 'Smoke', 'smoke-test', '${SEED.users.owner.id}')`);
      const again = run('up.sh');
      expect(again.status, again.output).toBe(0);
      expect(again.ms).toBeLessThan(UP_LIMIT_MS);
      expect(again.output).toContain('the seed data is already there');
      expectSeeded();
      // Data added after the seed survives an up; only reset removes it.
      expect(psql("select count(*) from workspaces where slug = 'smoke-test'")).toEqual(['1']);

      const reset = run('reset.sh');
      expect(reset.status, reset.output).toBe(0);
      expect(psql("select count(*) from workspaces where slug = 'smoke-test'")).toEqual(['0']);
      expectSeeded();
    },
    10 * 60_000,
  );
});

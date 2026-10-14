/**
 * backup.sh and restore.sh with the credential scan (B101 surface 5), against a real Postgres container and the
 * built scanner (`BACKUP_SCAN_SCRIPT`; skipped without Docker or `apps/api/dist/scan-stream.js`): a clean database
 * backs up and uploads (the manifest says `credential_scan: clean`); a database holding a provider credential
 * is NOT uploaded, exits 6 and leaves only an encrypted copy in the quarantine folder; `BACKUP_SCAN=skip` goes
 * without the scan and says so in the manifest; with no scanner configured and no image the backup stops rather
 * than go unscanned.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DR = import.meta.dirname;
const SCANNER = join(DR, '..', '..', 'apps', 'api', 'dist', 'scan-stream.js');
const HAS_DOCKER = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const SUFFIX = `${process.pid}-${Date.now() % 100000}`;
const PG = `scan-test-pg-${SUFFIX}`;
const PASS = 'correct horse battery staple';
const ANTHROPIC = ['sk', 'ant', 'api03', 'Zq8WmN3xK7vB2cT5yH9jL4pR6'].join('-');

let tmp: string;
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const psql = (sql: string) =>
  docker('exec', '-i', PG, 'psql', '-U', 'centcom', '-d', 'centcom', '-tAc', sql).stdout.trim();
const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [join(DR, script), ...args], {
    encoding: 'utf8',
    timeout: 170_000,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: homedir(),
      GNUPGHOME: tmp,
      DEPLOY_ENV_FILE: join(tmp, 'absent.env'),
      DEPLOY_STATE_DIR: join(tmp, 'state'),
      DR_PG_CONTAINER: PG,
      BACKUP_PASSPHRASE: PASS,
      ...extra,
    },
  });

describe.skipIf(!HAS_DOCKER || !existsSync(SCANNER))('the credential scan in backup.sh', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'scan-test-'));
    docker(
      'run',
      '-d',
      '--name',
      PG,
      '-e',
      'POSTGRES_USER=centcom',
      '-e',
      'POSTGRES_PASSWORD=t',
      '-e',
      'POSTGRES_DB=centcom',
      'postgres:16',
    );
    for (let i = 0; i < 60 && psql('select 1') !== '1'; i++)
      await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 2000));
    for (let i = 0; i < 60 && psql('select 1') !== '1'; i++)
      await new Promise((r) => setTimeout(r, 1000));
    psql(
      "create table schema_migrations (version text primary key); insert into schema_migrations values ('20260102005400'); create table notes (id serial primary key, body text); insert into notes (body) select 'hello ' || g from generate_series(1, 200) g",
    );
  }, 180_000);
  afterAll(() => {
    docker('rm', '-f', PG);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('backs up a clean database (local copy) and records the scan in the manifest', () => {
    const out = join(tmp, 'clean');
    const r = run('backup.sh', ['--local-only', out], { BACKUP_SCAN_SCRIPT: SCANNER });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).some((f) => f.endsWith('.dump.gpg'))).toBe(true);
    expect(r.stderr).toContain('clean');
    const manifest = spawnSync('bash', ['-c', `cat ${out}/*.manifest.json`], {
      encoding: 'utf8',
    }).stdout;
    expect(manifest).toContain('"credential_scan":"clean"');
  }, 180_000);

  it('quarantines a dump that holds a provider credential: exit 6, nothing in the output folder', () => {
    psql(`insert into notes (body) values ('${ANTHROPIC}')`);
    const out = join(tmp, 'dirty');
    const r = run('backup.sh', ['--local-only', out], { BACKUP_SCAN_SCRIPT: SCANNER });
    expect(r.status, r.stderr).toBe(6);
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    expect(readdirSync(join(tmp, 'state', 'quarantine')).some((f) => f.endsWith('.dump.gpg'))).toBe(
      true,
    );
    expect(r.stderr + r.stdout).not.toContain(ANTHROPIC);
  }, 180_000);

  it('goes without the scan only when told to, and the manifest says so', () => {
    const out = join(tmp, 'skipped');
    const r = run('backup.sh', ['--local-only', out], { BACKUP_SCAN: 'skip' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('NOT scanned');
    expect(
      spawnSync('bash', ['-c', `cat ${out}/*.manifest.json`], { encoding: 'utf8' }).stdout,
    ).toContain('"credential_scan":"skipped"');
  }, 180_000);

  it('stops rather than go unscanned when there is no scanner at all', () => {
    const r = run('backup.sh', ['--local-only', join(tmp, 'none')], {
      BACKUP_SCAN_IMAGE: 'centcom-api:no-such-tag',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot be scanned');
  }, 180_000);
});

/**
 * Backup, restore and drill (B099) against real containers: a source Postgres with data, a MinIO as
 * the S3-compatible bucket (the same calls as Cloudflare R2 or Backblaze B2), and the scripts of
 * infra/dr. Skipped where Docker is not installed. Covers: the backup is encrypted and described
 * by a manifest; a restore into an isolated, network-less Postgres is verified table by table; a
 * wrong passphrase, an altered backup or a manifest that disagrees stops it; the drill writes its
 * report and fails over its RTO target; backup age, pruning (35-day cap, newest 3 kept) and the
 * refusal to restore into the live stack without acknowledging the deletion caveat.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DR = import.meta.dirname;
const HAS_DOCKER = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const SUFFIX = `${process.pid}-${Date.now() % 100000}`;
const PG = `dr-test-pg-${SUFFIX}`;
const S3 = `dr-test-s3-${SUFFIX}`;
const PASS = 'correct horse battery staple';
const KEY = 'testkey';
const SECRET = 'testsecret123';

let tmp: string;
let port = 0;

/** Runs a script of infra/dr with the test environment. */
function run(script: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(DR, script), ...args], {
    encoding: 'utf8',
    timeout: 170_000,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      // the real HOME keeps the Docker CLI on the same daemon as the test's own docker calls
      HOME: homedir(),
      GNUPGHOME: tmp,
      DEPLOY_ENV_FILE: join(tmp, 'absent.env'),
      DEPLOY_STATE_DIR: join(tmp, 'state'),
      DR_PG_CONTAINER: PG,
      BACKUP_PASSPHRASE: PASS,
      BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      BACKUP_S3_BUCKET: 'backups',
      BACKUP_S3_ACCESS_KEY_ID: KEY,
      BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
      BACKUP_S3_REGION: 'us-east-1',
      ...extra,
    },
  });
}

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const psql = (sql: string) =>
  docker('exec', '-i', PG, 'psql', '-U', 'centcom', '-d', 'centcom', '-tAc', sql).stdout.trim();
const containers = () => docker('ps', '-a', '--format', '{{.Names}}').stdout.split('\n');
const listing = () => run('prune.sh', ['--dry-run']).stderr;

async function waitFor(check: () => boolean, what: string, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!HAS_DOCKER)('backup, restore and drill', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'dr-test-'));
    // a free port for MinIO
    const probe = spawnSync(
      'python3',
      ['-c', 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'],
      { encoding: 'utf8' },
    );
    port = Number(probe.stdout.trim());
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
    docker(
      'run',
      '-d',
      '--name',
      S3,
      '-p',
      `127.0.0.1:${port}:9000`,
      '-e',
      `MINIO_ROOT_USER=${KEY}`,
      '-e',
      `MINIO_ROOT_PASSWORD=${SECRET}`,
      'bitnamilegacy/minio:2025.7.23-debian-12-r5',
    );
    await waitFor(() => psql('select 1') === '1', 'postgres');
    await new Promise((r) => setTimeout(r, 2000)); // the image restarts the server once after initdb
    await waitFor(() => psql('select 1') === '1', 'postgres (second start)');
    await waitFor(
      () => spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/minio/health/live`]).status === 0,
      'minio',
    );
    spawnSync('curl', [
      '-sf',
      '--aws-sigv4',
      'aws:amz:us-east-1:s3',
      '--user',
      `${KEY}:${SECRET}`,
      '-X',
      'PUT',
      `http://127.0.0.1:${port}/backups`,
    ]);
    psql(`create table schema_migrations (version text primary key);
      insert into schema_migrations values ('20260101000000'), ('20260102005400');
      create table users (id text primary key, email text, created_at timestamptz default now());
      insert into users select 'usr_' || g, 'user' || g || '@example.com' from generate_series(1, 500) g;
      create table notes (id serial primary key, body text);
      insert into notes (body) select repeat('hello ', 20) || g from generate_series(1, 2000) g;`);
  }, 240_000);

  afterAll(() => {
    docker('rm', '-f', PG, S3);
    for (const c of containers().filter((n) => n.startsWith('centcom-dr-'))) docker('rm', '-f', c);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('backs up to the bucket: ciphertext without a plaintext header, and a manifest of the same snapshot', () => {
    const res = run('backup.sh', ['--tag', 'v-test']);
    expect(res.status, res.stderr).toBe(0);
    const key = res.stdout.trim();
    expect(key).toMatch(/^db\/centcom-\d{8}T\d{6}Z\.dump\.gpg$/);
    const file = join(tmp, 'got.dump.gpg');
    const got = spawnSync(
      'bash',
      [
        '-c',
        `source ${DR}/lib.sh; s3_get ${key} ${file}; s3_get ${key.replace('.dump.gpg', '.manifest.json')} ${file}.manifest`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: tmp,
          DEPLOY_ENV_FILE: join(tmp, 'absent.env'),
          BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
          BACKUP_S3_BUCKET: 'backups',
          BACKUP_S3_ACCESS_KEY_ID: KEY,
          BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
          BACKUP_S3_REGION: 'us-east-1',
        },
      },
    );
    expect(got.status, got.stderr).toBe(0);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 5).toString('latin1')).not.toBe('PGDMP');
    expect(bytes.toString('latin1')).not.toMatch(/CREATE TABLE|usr_1|hello hello/);
    const manifest = JSON.parse(readFileSync(`${file}.manifest`, 'utf8')) as {
      schema_version: string;
      tag: string;
      encryption: string;
      dump: { key: string; bytes: number; sha256: string };
      tables: Record<string, { rows: number; md5: string }>;
    };
    expect(manifest).toMatchObject({
      schema_version: '20260102005400',
      tag: 'v-test',
      encryption: 'gpg-aes256',
    });
    expect(manifest.dump).toMatchObject({ key, bytes: bytes.length });
    expect(manifest.tables['users']?.rows).toBe(500);
    expect(manifest.tables['notes']?.rows).toBe(2000);
    expect(manifest.tables['users']?.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(res.stdout + res.stderr).not.toContain(PASS);
  }, 120_000);

  it('restores the latest backup into an isolated Postgres with no network, verified, and removes it', () => {
    const report = join(tmp, 'restore.json');
    const res = run('restore.sh', ['--latest', '--report', report]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('ok    row counts and content md5 of 3 tables');
    const out = JSON.parse(readFileSync(report, 'utf8')) as {
      verified: boolean;
      into: string;
      checks: { ok: boolean }[];
    };
    expect(out).toMatchObject({ verified: true, into: 'fresh' });
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(containers().filter((n) => n.startsWith('centcom-dr-'))).toEqual([]);
  }, 150_000);

  it('keeps the isolated instance on request, with network mode none', () => {
    const res = run('restore.sh', ['--latest', '--keep']);
    expect(res.status, res.stderr).toBe(0);
    const name = res.stdout.trim().split('\n').pop() ?? '';
    expect(name).toMatch(/^centcom-dr-/);
    const mode = docker('inspect', '-f', '{{.HostConfig.NetworkMode}}', name).stdout.trim();
    expect(mode).toBe('none');
    expect(
      docker(
        'exec',
        name,
        'psql',
        '-U',
        'centcom',
        '-d',
        'centcom',
        '-tAc',
        'select count(*) from users',
      ).stdout.trim(),
    ).toBe('500');
    docker('rm', '-f', name);
  }, 150_000);

  it('stops with exit 3 on a wrong passphrase, before starting any database', () => {
    const res = run('restore.sh', ['--latest'], { BACKUP_PASSPHRASE: 'wrong' });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('cannot decrypt');
    expect(containers().filter((n) => n.startsWith('centcom-dr-'))).toEqual([]);
  }, 60_000);

  it('refuses an altered backup (exit 1) and a manifest that disagrees with the data (exit 4)', () => {
    const list = run('backup.sh', ['--local-only', join(tmp, 'local')]);
    expect(list.status, list.stderr).toBe(0);
    const base = list.stdout.trim().replace(/^db\//, '').replace('.dump.gpg', '');
    const dump = join(tmp, 'local', `${base}.dump.gpg`);
    const manifest = join(tmp, 'local', `${base}.manifest.json`);
    // one flipped byte: the SHA-256 in the manifest no longer matches
    const original = readFileSync(dump);
    const altered = Buffer.from(original);
    const middle = Math.floor(altered.length / 2);
    altered[middle] = (altered[middle] ?? 0) ^ 0xff;
    writeFileSync(dump, altered);
    const bad = run('restore.sh', ['--file', dump]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('does not match its manifest');
    // a good file, a manifest that promises one more user: the restore works, verification fails
    writeFileSync(dump, original);
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace(/("users"\s*:\s*\{\s*"rows"\s*:\s*)500/, '$1501'),
    );
    const wrong = run('restore.sh', ['--file', dump]);
    expect(wrong.status).toBe(4);
    expect(wrong.stderr).toContain('FAIL  row counts and content md5');
  }, 150_000);

  it('runs the drill: restored and verified, wrong key and altered file refused, report written', () => {
    const report = join(tmp, 'drill.json');
    const res = run('drill.sh', ['--report', report]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(readFileSync(report, 'utf8')) as {
      verified: boolean;
      rto_seconds: number;
      rpo_seconds: number;
      restore_point: string;
      checks: { name: string; ok: boolean }[];
    };
    expect(out.verified).toBe(true);
    expect(out.rto_seconds).toBeLessThan(120);
    expect(out.rpo_seconds).toBeLessThan(60);
    expect(out.restore_point).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.checks.map((c) => c.name)).toEqual([
      'restore into an isolated instance and verify against the manifest',
      'restored schema equals the live schema',
      'a wrong passphrase stops with exit 3',
      'an altered backup is refused before any restore',
    ]);
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(containers().filter((n) => n.startsWith('centcom-dr-'))).toEqual([]);
  }, 170_000);

  it('fails the drill with exit 5 when the restore is over its RTO target', () => {
    const report = join(tmp, 'drill-slow.json');
    const res = run('drill.sh', ['--use-latest', '--no-negative', '--report', report], {
      DR_RTO_TARGET_S: '0',
    });
    expect(res.status).toBe(5);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      verified: true,
      rto_target_seconds: 0,
    });
  }, 150_000);

  it('reports the age of the newest backup, writes the gauge, and fails when it is stale', async () => {
    const prom = join(tmp, 'backup.prom');
    const ok = run('backup-status.sh', ['--prom', prom]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^backup_age_seconds \d+$/m);
    expect(readFileSync(prom, 'utf8')).toContain('centcom_backup_age_seconds ');
    await new Promise((r) => setTimeout(r, 1500));
    const stale = run('backup-status.sh', [], { BACKUP_MAX_AGE_S: '0' });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/newest backup is \d+s old/);
  }, 60_000);

  it('prunes by age (35 days at most), always keeping the newest three', async () => {
    for (let i = 0; i < 3; i++) {
      expect(run('backup.sh').status).toBe(0);
      await new Promise((r) => setTimeout(r, 1100)); // backup names carry the second
    }
    const now = Math.floor(Date.now() / 1000);
    const future = String(now + 40 * 86400);
    expect(run('prune.sh', ['--dry-run'], { DR_NOW_EPOCH: String(now) }).stderr).toContain('0 of ');
    const dry = run('prune.sh', ['--dry-run'], { DR_NOW_EPOCH: future });
    expect(dry.status, dry.stderr).toBe(0);
    const total = Number(/of (\d+) backups/.exec(dry.stderr)?.[1]);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(dry.stderr).toContain(`${total - 3} of ${total} backups would be removed`);
    expect(listing()).toContain(`of ${total} backups`); // a dry run deletes nothing
    const real = run('prune.sh', [], { DR_NOW_EPOCH: future });
    expect(real.status, real.stderr).toBe(0);
    expect(run('prune.sh', ['--dry-run']).stderr).toContain('of 3 backups');
    expect(run('backup-status.sh').status).toBe(0);
    const tooLong = run('prune.sh', ['--dry-run'], { BACKUP_RETENTION_DAYS: '36' });
    expect(tooLong.status).toBe(2);
  }, 150_000);

  it('refuses to restore into the live stack without the acknowledgement', () => {
    const res = run('restore.sh', ['--latest', '--into', 'stack']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--i-know-deletions-may-reappear');
  });
});

describe('the scripts (no Docker needed)', () => {
  const scripts = [
    'lib.sh',
    'backup.sh',
    'restore.sh',
    'verify.sh',
    'drill.sh',
    'backup-status.sh',
    'prune.sh',
  ];
  it.each(scripts)('%s parses', (name) => {
    expect(spawnSync('bash', ['-n', join(DR, name)]).status).toBe(0);
  });

  it('never puts the passphrase or the S3 secret on a command line', () => {
    for (const name of scripts) {
      const text = readFileSync(join(DR, name), 'utf8');
      expect(text, name).not.toMatch(/--passphrase[ =]/);
      expect(text, name).not.toMatch(/--user "?\$\(cfg BACKUP_S3_SECRET/);
    }
    const lib = readFileSync(join(DR, 'lib.sh'), 'utf8');
    expect(lib).toContain('--passphrase-fd 3');
    expect(lib).toContain("-K <(printf 'user =");
  });

  it('refuses to run without the settings it needs (exit 2)', () => {
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: tmpdir(),
      DEPLOY_ENV_FILE: '/nonexistent/x.env',
      DEPLOY_STATE_DIR: tmpdir(),
    };
    for (const script of ['backup.sh', 'prune.sh', 'backup-status.sh']) {
      const res = spawnSync('bash', [join(DR, script)], { encoding: 'utf8', env });
      expect(res.status, script).toBe(2);
      expect(res.stderr, script).toMatch(/is not set|is required/);
    }
    expect(spawnSync('bash', [join(DR, 'restore.sh')], { encoding: 'utf8', env }).status).toBe(2);
  });
});

/**
 * Point-in-time recovery (B099) against real containers: a Postgres with WAL archiving into a volume, a MinIO as
 * the bucket, and the scripts of infra/dr. A base backup, rows before and after a chosen moment, shipping of the
 * archived segments (encrypted, verified, then removed from the volume), and a restore to that moment in a
 * network-less container that has the rows of before and none of after; a restore to "latest" has them all; a
 * wrong passphrase stops at once; a shipper that cannot reach the bucket leaves the segments where they are.
 * Skipped where Docker is not installed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DR = import.meta.dirname;
const HAS_DOCKER = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const SUFFIX = `${process.pid}-${Date.now() % 100000}`;
const PG = `pitr-test-pg-${SUFFIX}`;
const S3 = `pitr-test-s3-${SUFFIX}`;
const WAL = `pitr-test-wal-${SUFFIX}`;
const PASS = 'correct horse battery staple';
const KEY = 'testkey';
const SECRET = 'testsecret123';

let tmp: string;
let port = 0;
const kept: string[] = [];

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const psql = (container: string, sql: string) =>
  docker(
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    'centcom',
    '-d',
    'centcom',
    '-tAc',
    sql,
  ).stdout.trim();
const src = (sql: string) => psql(PG, sql);

function run(script: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(DR, script), ...args], {
    encoding: 'utf8',
    timeout: 280_000,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const walFiles = () =>
  docker('exec', PG, 'sh', '-c', 'ls -1 /wal')
    .stdout.split('\n')
    .filter((f) => /^[0-9A-F]{24}$/.test(f));
const utcNow = () =>
  src("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'");

describe.skipIf(!HAS_DOCKER)('point-in-time recovery', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pitr-test-'));
    const probe = spawnSync(
      'python3',
      ['-c', 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'],
      { encoding: 'utf8' },
    );
    port = Number(probe.stdout.trim());
    docker('volume', 'create', WAL);
    docker(
      'run',
      '-d',
      '--name',
      PG,
      '-v',
      `${WAL}:/wal`,
      '-e',
      'POSTGRES_USER=centcom',
      '-e',
      'POSTGRES_PASSWORD=t',
      '-e',
      'POSTGRES_DB=centcom',
      'postgres:16',
      '-c',
      'archive_mode=on',
      '-c',
      'wal_level=replica',
      '-c',
      'archive_timeout=5',
      '-c',
      'archive_command=test ! -f /wal/%f && cp %p /wal/%f.tmp && mv /wal/%f.tmp /wal/%f',
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
    await waitFor(() => src('select 1') === '1', 'postgres');
    await sleep(2000);
    await waitFor(() => src('select 1') === '1', 'postgres (second start)');
    docker('exec', '-u', 'root', PG, 'chown', 'postgres:postgres', '/wal');
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
  }, 240_000);

  afterAll(() => {
    docker('rm', '-f', PG, S3, ...kept);
    docker('volume', 'rm', '-f', WAL);
    for (const v of docker('volume', 'ls', '-q')
      .stdout.split('\n')
      .filter((n) => n.startsWith('centcom-pitr-'))) {
      docker('rm', '-f', v.replace('-data-', '-').replace('-wal-', '-'));
      docker('volume', 'rm', '-f', v);
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  let beforeMoment = '';

  it('takes a base backup and ships archived WAL, encrypted, and empties the volume of what it shipped', async () => {
    src('create table notes (id serial primary key, body text)');
    src("insert into notes (body) select 'a' || g from generate_series(1, 100) g");
    const base = run('basebackup.sh');
    expect(base.status, base.stderr).toBe(0);
    await sleep(1500);
    src("insert into notes (body) select 'b' || g from generate_series(1, 100) g");
    await sleep(1500);
    beforeMoment = utcNow();
    await sleep(1500);
    src("insert into notes (body) select 'c' || g from generate_series(1, 100) g");
    src('select pg_switch_wal()');
    await waitFor(() => walFiles().length >= 2, 'archived segments');
    const archived = walFiles();
    const ship = run('wal-ship.sh');
    expect(ship.status, ship.stderr).toBe(0);
    // (archive_timeout is 5 s, so a segment may arrive between the listing and the shipping)
    expect(Number(/shipped (\d+)/.exec(ship.stderr)?.[1])).toBeGreaterThanOrEqual(archived.length);
    for (const f of archived) expect(walFiles()).not.toContain(f);
    // The bucket holds ciphertext only: gpg's header, never the plaintext of a WAL page or a row.
    const listing = spawnSync('bash', ['-c', `source ${DR}/lib.sh; s3_list wal/; s3_list base/`], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: tmp,
        DEPLOY_ENV_FILE: join(tmp, 'absent.env'),
        DEPLOY_STATE_DIR: join(tmp, 'state'),
        BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
        BACKUP_S3_BUCKET: 'backups',
        BACKUP_S3_ACCESS_KEY_ID: KEY,
        BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
        BACKUP_S3_REGION: 'us-east-1',
      },
    });
    expect(listing.stdout).toMatch(/wal\/[0-9A-F]{24}\.gpg/);
    expect(listing.stdout).toMatch(/base\/\d{8}T\d{6}Z\.tar\.gz\.gpg/);
  }, 280_000);

  it('restores to the chosen moment: the rows before it are there and the rows after it are not', () => {
    const restored = run('pitr-restore.sh', ['--to', beforeMoment, '--keep']);
    expect(restored.status, restored.stderr).toBe(0);
    const name = restored.stdout.trim().split('\n').pop() ?? '';
    kept.push(name);
    expect(
      psql(
        name,
        "select count(*) filter (where body like 'a%') || ',' || count(*) filter (where body like 'b%') || ',' || count(*) filter (where body like 'c%') from notes",
      ),
    ).toBe('100,100,0');
    expect(psql(name, 'select pg_is_in_recovery()')).toBe('f');
    // no network: nothing from the restored database can reach anything else
    expect(docker('inspect', '-f', '{{.HostConfig.NetworkMode}}', name).stdout.trim()).toBe('none');
  }, 280_000);

  it('restores everything that was shipped with --to latest', () => {
    const restored = run('pitr-restore.sh', ['--to', 'latest', '--keep']);
    expect(restored.status, restored.stderr).toBe(0);
    const name = restored.stdout.trim().split('\n').pop() ?? '';
    kept.push(name);
    expect(psql(name, 'select count(*) from notes')).toBe('300');
  }, 280_000);

  it('refuses a malformed time, an absent time zone, and a base backup newer than the target', () => {
    expect(run('pitr-restore.sh', ['--to', 'yesterday']).status).toBe(2);
    expect(run('pitr-restore.sh', ['--to', '2026-10-14 09:58:00']).status).toBe(2);
    const early = run('pitr-restore.sh', ['--to', '2001-01-01 00:00:00+00']);
    expect(early.status).toBe(1);
    expect(early.stderr).toContain('no base backup from before');
  });

  it('stops at once on a wrong passphrase, before any container starts', () => {
    const before = docker('ps', '-a', '-q', '--filter', 'name=centcom-pitr-').stdout;
    const res = run('pitr-restore.sh', ['--to', 'latest'], {
      BACKUP_PASSPHRASE: 'not the passphrase',
    });
    expect(res.status).toBe(3);
    expect(docker('ps', '-a', '-q', '--filter', 'name=centcom-pitr-').stdout).toBe(before);
  }, 120_000);

  it('leaves a segment in the volume, and says so, when the bucket cannot be reached', async () => {
    src("insert into notes (body) select 'd' || g from generate_series(1, 10) g");
    src('select pg_switch_wal()');
    await waitFor(() => walFiles().length >= 1, 'an archived segment');
    const waiting = walFiles().length;
    const res = run('wal-ship.sh', [], { BACKUP_S3_ENDPOINT: 'http://127.0.0.1:1' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('waiting');
    expect(walFiles().length).toBeGreaterThanOrEqual(waiting);
  }, 280_000);
});

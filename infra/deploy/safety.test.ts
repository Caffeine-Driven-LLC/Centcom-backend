/**
 * The destructive paths of the deploy and DR scripts, run against a fake `docker` that records its
 * calls (no Docker needed): a restore into the live stack or a rollback with --restore-db dumps the
 * current database BEFORE it drops it (and says so), and a migration check that could not run is
 * never read as "no contract migration".
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DEPLOY = import.meta.dirname;
const DR = join(DEPLOY, '..', 'dr');
const HAS_GPG = spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status === 0;
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"--entrypoint grep"*) exit "\${FAKE_GREP_RC:-1}" ;;
  *"pg_restore"*) cat >/dev/null; exit 0 ;;
  *" status"*) printf 'applied  1_a  2026-01-01T00:00:00.000Z\\npending  20260101000000_core_schema\\n1 applied, 1 pending\\n'; exit 0 ;;
esac
exit 0
`;

let tmp: string;
let envFile: string;
let log: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'safety-test-'));
  await mkdir(join(tmp, 'bin'));
  await writeFile(join(tmp, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
  log = join(tmp, 'docker.log');
  envFile = join(tmp, 'production.env');
  const gen = spawnSync('node', [join(DEPLOY, 'gen-env.mjs'), '--out', envFile]);
  expect(gen.status).toBe(0);
  const text = (await readFile(envFile, 'utf8')).replace(/=CHANGE_ME.*$/gm, '=filled');
  await writeFile(envFile, text, { mode: 0o600 });
  await chmod(envFile, 0o600);
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** Runs `script` with the fake docker first on the PATH; returns the result and the docker calls. */
async function run(script: string, args: string[], extra: Record<string, string> = {}) {
  await writeFile(log, '');
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(tmp, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
      HOME: tmp,
      GNUPGHOME: join(tmp, 'gnupg'),
      DEPLOY_ENV_FILE: envFile,
      DEPLOY_STATE_DIR: join(tmp, 'state'),
      FAKE_DOCKER_LOG: log,
      BACKUP_PASSPHRASE: 'pw',
      ...extra,
    },
  });
  const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  return { res, calls };
}
const at = (calls: string[], word: string) => calls.findIndex((c) => c.includes(word));

describe('rollback.sh --restore-db', () => {
  const args = ['--restore-db', 'pre-v2-20260101T000000Z.dump', '--to', 'v1'];

  it('dumps the current database before dropping it', async () => {
    const { res, calls } = await run(join(DEPLOY, 'rollback.sh'), args);
    expect(res.status, res.stderr).toBe(0);
    const dump = at(calls, 'pg_dump');
    const drop = at(calls, 'dropdb');
    expect(dump).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(dump);
    expect(calls[dump]).toContain('pre-before-restore-');
    expect(res.stderr + res.stdout).toContain('safety copy');
  });

  it('drops nothing when the safety copy cannot be taken, unless told to skip it', async () => {
    const failing = join(tmp, 'bin-failing');
    await mkdir(failing, { recursive: true });
    await writeFile(
      join(failing, 'docker'),
      `#!/bin/sh\necho "$*" >> "$FAKE_DOCKER_LOG"\ncase "$*" in *pg_dump*|*"pg_restore --list"*) exit 1 ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    const env = { PATH: `${failing}:/usr/bin:/bin` };
    const refused = await run(join(DEPLOY, 'rollback.sh'), args, env);
    expect(refused.res.status).toBe(1);
    expect(refused.res.stderr).toContain('--skip-safety-copy');
    expect(at(refused.calls, 'dropdb')).toBe(-1);
    const skipped = await run(join(DEPLOY, 'rollback.sh'), [...args, '--skip-safety-copy'], env);
    expect(skipped.res.status, skipped.res.stderr).toBe(0);
    expect(at(skipped.calls, 'pg_dump')).toBe(-1);
    expect(at(skipped.calls, 'dropdb')).toBeGreaterThan(-1);
  });
});

describe.skipIf(!HAS_GPG)('restore.sh --into stack', () => {
  let dump: string;
  beforeAll(async () => {
    await mkdir(join(tmp, 'gnupg'), { mode: 0o700 });
    const plain = join(tmp, 'plain.bin');
    await writeFile(plain, 'not really a dump');
    dump = join(tmp, 'centcom-1.dump.gpg');
    const enc = spawnSync(
      'gpg',
      ['--batch', '--yes', '--quiet', '--pinentry-mode', 'loopback', '--passphrase', 'pw'].concat([
        '--symmetric',
        '--output',
        dump,
        plain,
      ]),
      { env: { PATH: '/usr/bin:/bin', GNUPGHOME: join(tmp, 'gnupg') } },
    );
    expect(enc.status).toBe(0);
    const sha = createHash('sha256')
      .update(await readFile(dump))
      .digest('hex');
    await writeFile(join(tmp, 'centcom-1.manifest.json'), `{"dump":{"sha256":"${sha}"}}`);
  });

  const args = () => ['--file', dump, '--into', 'stack', '--i-know-deletions-may-reappear'];

  it('dumps the current database before dropping it', async () => {
    const { calls } = await run(join(DR, 'restore.sh'), args());
    const dumpAt = at(calls, 'pg_dump');
    const drop = at(calls, 'dropdb');
    expect(dumpAt).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(dumpAt);
  });

  it('--skip-safety-copy leaves the dump out', async () => {
    const { calls } = await run(join(DR, 'restore.sh'), [...args(), '--skip-safety-copy']);
    expect(at(calls, 'pg_dump')).toBe(-1);
    expect(at(calls, 'dropdb')).toBeGreaterThan(-1);
  });
});

describe('migrate-safe.sh', () => {
  const migrate = join(DEPLOY, 'migrate-safe.sh');

  it('stops, before any backup, when the contract check could not run', async () => {
    const { res, calls } = await run(migrate, ['--tag', 't'], { FAKE_GREP_RC: '2' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('could not check');
    expect(at(calls, 'pg_dump')).toBe(-1);
  });

  it('refuses a contract migration (exit 3) and goes on without one', async () => {
    const contract = await run(migrate, ['--tag', 't'], { FAKE_GREP_RC: '0' });
    expect(contract.res.status, contract.res.stderr).toBe(3);
    const plain = await run(migrate, ['--tag', 't'], { FAKE_GREP_RC: '1' });
    expect(plain.res.status, plain.res.stderr).toBe(0);
    expect(at(plain.calls, 'pg_dump')).toBeGreaterThan(-1);
  });
});

/**
 * Dev stack files (B012): the compose file publishes every port on 127.0.0.1 only (acceptance 5;
 * from `docker compose config` where Docker is installed, from the file itself everywhere), pins
 * its images and has a health check and a named volume per service; the scripts parse and are
 * wired to `pnpm dev:*`; .env.local is written only when missing and is git-ignored (acceptance
 * 7); a taken port is reported with the variable that moves it; the docs mark the seeded device
 * keys as test-only (acceptance 6).
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED } from './seed.js';

const ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE_FILE = join(ROOT, 'infra', 'compose', 'docker-compose.yml');
const LIB = join(ROOT, 'tools', 'dev', 'lib.sh');
const SCRIPTS = ['tools/dev/up.sh', 'tools/dev/down.sh', 'tools/dev/reset.sh', 'tools/dev/lib.sh'];
const SERVICES = ['postgres', 'redis', 'minio', 'mailpit'];

const read = (path: string) => readFile(join(ROOT, path), 'utf8');
const HAS_COMPOSE = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;

/** Runs bash with lib.sh sourced; env adds to the process environment. */
function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}\n${script}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
}

/** The compose file's top-level service blocks, by name: the lines indented under each. */
function serviceBlocks(text: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = undefined;
      continue;
    }
    const name = /^ {2}([a-z0-9-]+):\s*$/.exec(line)?.[1];
    if (inServices && name !== undefined) {
      current = [];
      blocks.set(name, current);
    } else if (
      inServices &&
      current !== undefined &&
      line.trim() !== '' &&
      !line.trim().startsWith('#')
    ) {
      current.push(line);
    }
  }
  return blocks;
}

/** The entries of a service's `ports:` list. */
function portsOf(block: string[]): string[] {
  const start = block.findIndex((l) => /^ {4}ports:\s*$/.test(l));
  if (start < 0) return [];
  const entries: string[] = [];
  for (const line of block.slice(start + 1)) {
    const entry = /^ {6}- (.*)$/.exec(line)?.[1];
    if (entry === undefined) break;
    entries.push(entry);
  }
  return entries;
}

describe('infra/compose/docker-compose.yml', () => {
  it('has the four services, each with a pinned image, a health check and a named volume', async () => {
    const text = await read('infra/compose/docker-compose.yml');
    const blocks = serviceBlocks(text);
    expect([...blocks.keys()]).toEqual(SERVICES);
    for (const [name, block] of blocks) {
      const image = block
        .find((l) => /^ {4}image: /.test(l))
        ?.trim()
        .slice('image: '.length);
      expect(image, name).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+$/);
      expect(image, name).not.toMatch(/:latest$/);
      expect(
        block.some((l) => /^ {4}healthcheck:/.test(l)),
        name,
      ).toBe(true);
      expect(
        block.some((l) => new RegExp(`^ {6}- ${name}-data:/`).test(l)),
        `${name} keeps its data in the named volume ${name}-data`,
      ).toBe(true);
      expect(text).toMatch(new RegExp(`^ {2}${name}-data:\\s*$`, 'm'));
    }
    expect(blocks.get('postgres')?.join('\n')).toContain('image: postgres:16');
    expect(blocks.get('redis')?.join('\n')).toContain('image: redis:7');
  });

  it('publishes every port on 127.0.0.1 only, each movable by a CENTCOM_DEV_* variable (acceptance 5)', async () => {
    const text = await read('infra/compose/docker-compose.yml');
    const ports = [...serviceBlocks(text).values()].flatMap(portsOf);
    expect(ports).toHaveLength(6);
    for (const port of ports) {
      expect(port).toMatch(/^'127\.0\.0\.1:\$\{CENTCOM_DEV_[A-Z_]+_PORT:-\d+\}:\d+'$/);
    }
    // Nothing else can publish a port or share the host's network.
    expect(text).not.toMatch(/^\s*(network_mode|expose):/m);
    expect(text.match(/^\s*ports:/gm)).toHaveLength(4);
  });

  it('uses only the fixed dev-only password', async () => {
    const text = await read('infra/compose/docker-compose.yml');
    for (const line of text.split('\n').filter((l) => /PASSWORD:/.test(l))) {
      expect(line.trim()).toMatch(/^[A-Z_]+PASSWORD: dev-only$/);
    }
  });

  describe.runIf(HAS_COMPOSE)('as docker compose reads it', () => {
    const config = (env: Record<string, string> = {}) =>
      spawnSync('docker', ['compose', '--file', COMPOSE_FILE, 'config', '--format', 'json'], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 30_000,
      });
    type Port = { host_ip?: string; published?: string; target: number };
    const ports = (stdout: string) =>
      Object.entries(
        (JSON.parse(stdout) as { services: Record<string, { ports?: Port[] }> }).services,
      ).flatMap(([service, s]) => (s.ports ?? []).map((p) => ({ service, ...p })));

    it('is valid (docker compose config -q)', () => {
      const run = spawnSync('docker', ['compose', '--file', COMPOSE_FILE, 'config', '-q'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(run.status, run.stderr).toBe(0);
    });

    it('binds every published port to 127.0.0.1, also when one is moved (acceptance 5)', () => {
      const plain = config();
      expect(plain.status, plain.stderr).toBe(0);
      const published = ports(plain.stdout);
      expect(published.map((p) => `${p.service}:${p.published}`).sort()).toEqual([
        'mailpit:1025',
        'mailpit:8025',
        'minio:9000',
        'minio:9001',
        'postgres:5432',
        'redis:6379',
      ]);
      for (const p of published) expect(p.host_ip, `${p.service} ${p.target}`).toBe('127.0.0.1');

      const moved = config({ CENTCOM_DEV_POSTGRES_PORT: '15432' });
      expect(moved.status, moved.stderr).toBe(0);
      const postgres = ports(moved.stdout).find((p) => p.service === 'postgres');
      expect(postgres).toMatchObject({ host_ip: '127.0.0.1', published: '15432', target: 5432 });
    });
  });
});

describe('the dev scripts', () => {
  it('are wired to pnpm dev:up, dev:down, dev:reset and dev:seed', async () => {
    const scripts = (JSON.parse(await read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts).toMatchObject({
      'dev:up': 'bash tools/dev/up.sh',
      'dev:down': 'bash tools/dev/down.sh',
      'dev:reset': 'bash tools/dev/reset.sh',
      'dev:seed': 'tsx --tsconfig tsconfig.test.json tools/dev/seed.ts',
    });
  });

  it.each([...SCRIPTS, 'infra/compose/minio-init.sh'])('%s is valid bash', (path) => {
    const run = spawnSync('bash', ['-n', join(ROOT, path)], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it('point the services at the stack on 127.0.0.1 with the dev-only password', () => {
    const run = bash('echo "$DEV_DATABASE_URL $DEV_REDIS_URL"');
    expect(run.stdout.trim()).toBe(
      'postgres://centcom:dev-only@127.0.0.1:5432/centcom_dev redis://127.0.0.1:6379/0',
    );
    const moved = bash('echo "$DEV_DATABASE_URL"', { CENTCOM_DEV_POSTGRES_PORT: '15432' });
    expect(moved.stdout.trim()).toBe('postgres://centcom:dev-only@127.0.0.1:15432/centcom_dev');
  });
});

describe('a port that is already taken', () => {
  it('is reported with its service and the variable that moves it, unless that service is ours', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = String((server.address() as AddressInfo).port);
    try {
      const taken = bash('dev_check_ports', { CENTCOM_DEV_REDIS_PORT: port });
      expect(taken.status).toBe(1);
      expect(taken.stderr).toContain(
        `dev: port ${port} (redis) is already in use on 127.0.0.1; free it, or set CENTCOM_DEV_REDIS_PORT to another port`,
      );
      const ours = bash('dev_check_ports redis', { CENTCOM_DEV_REDIS_PORT: port });
      expect(ours.stderr).not.toContain('(redis)');
    } finally {
      server.close();
    }
  });
});

describe('.env.local', () => {
  it('is git-ignored (acceptance 7)', () => {
    const run = spawnSync('git', ['check-ignore', '--quiet', '.env.local'], { cwd: ROOT });
    expect(run.status).toBe(0);
  });

  it('is written from .env.example names when missing, and never overwritten (acceptance 7)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'centcom-dev-env-'));
    try {
      const target = join(dir, '.env.local');
      const write = () =>
        bash(`dev_write_env_local "$DEV_ENV_EXAMPLE" ${JSON.stringify(target)}`, {
          CENTCOM_DEV_REDIS_PORT: '16379',
        });

      const first = write();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('wrote');
      const written = await readFile(target, 'utf8');
      const names = (text: string) =>
        text
          .split('\n')
          .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
          .map((l) => l.slice(0, l.indexOf('=')));
      expect(names(written)).toEqual(names(await read('.env.example')));
      expect(written).toMatch(
        /^DATABASE_URL=postgres:\/\/centcom:dev-only@127\.0\.0\.1:5432\/centcom_dev$/m,
      );
      expect(written).toMatch(/^REDIS_URL=redis:\/\/127\.0\.0\.1:16379\/0$/m);

      await writeFile(target, 'EDITED=1\n');
      const second = write();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('kept');
      expect(await readFile(target, 'utf8')).toBe('EDITED=1\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('docs/dev-environment.md', () => {
  it('marks the seeded device keys as test-only and lists them (acceptance 6)', async () => {
    const doc = await read('docs/dev-environment.md');
    expect(doc).toMatch(/test-only/i);
    for (const device of Object.values(SEED.devices)) {
      for (const value of [device.id, device.x25519Pub, device.ed25519Pub, device.fingerprint]) {
        expect(doc).toContain(value);
      }
    }
  });

  it('names the seeded ids, every port and every command', async () => {
    const doc = await read('docs/dev-environment.md');
    for (const user of Object.values(SEED.users)) expect(doc).toContain(user.id);
    expect(doc).toContain(SEED.workspace.id);
    expect(doc).toContain(SEED.session.id);
    for (const port of ['5432', '6379', '9000', '9001', '1025', '8025'])
      expect(doc).toContain(port);
    for (const command of ['dev:up', 'dev:down', 'dev:reset', 'dev:seed']) {
      expect(doc).toContain(`pnpm ${command}`);
    }
  });
});

/**
 * Throwaway Redis, Postgres and MinIO for a local load test (B095): containers on random loopback
 * ports with synthetic credentials, migrated and removed again. Redis runs with the AOF on, as in
 * infra/deploy/docker-compose.prod.yml.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Backing {
  redisUrl: string;
  databaseUrl: string;
  objectStore: { endpoint: string; bucket: string; accessKey: string; secretKey: string };
  /** The container names, for resource sampling and removal. */
  containers: { redis: string; postgres: string; minio: string };
  stop(): void;
}

function docker(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  what: string,
  tries = 90,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts the three services. Throws (after removing what started) if one does not come up. */
export async function startBacking(): Promise<Backing> {
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const names = { redis: `lt-redis-${tag}`, postgres: `lt-pg-${tag}`, minio: `lt-minio-${tag}` };
  const [redisPort, pgPort, minioPort] = [await freePort(), await freePort(), await freePort()];
  const stop = (): void => {
    for (const name of Object.values(names)) docker('rm', '-f', name);
  };
  try {
    const run = (args: string[]): void => {
      const r = docker('run', '-d', ...args);
      if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
    };
    run([
      '--name',
      names.redis,
      '-p',
      `127.0.0.1:${redisPort}:6379`,
      'redis:7',
      'redis-server',
      '--appendonly',
      'yes',
    ]);
    run([
      '--name',
      names.postgres,
      '-p',
      `127.0.0.1:${pgPort}:5432`,
      '-e',
      'POSTGRES_USER=centcom',
      '-e',
      'POSTGRES_PASSWORD=loadtest',
      '-e',
      'POSTGRES_DB=centcom',
      'postgres:16',
    ]);
    run([
      '--name',
      names.minio,
      '-p',
      `127.0.0.1:${minioPort}:9000`,
      '-e',
      'MINIO_ROOT_USER=loadtest',
      '-e',
      'MINIO_ROOT_PASSWORD=loadtest-secret',
      'bitnamilegacy/minio:2025.7.23-debian-12-r5',
    ]);
    await waitUntil(
      () => docker('exec', names.redis, 'redis-cli', 'ping').stdout.includes('PONG'),
      'redis',
    );
    await waitUntil(
      () =>
        docker(
          'exec',
          names.postgres,
          'psql',
          '-U',
          'centcom',
          '-d',
          'centcom',
          '-tAc',
          'select 1',
        ).stdout.trim() === '1',
      'postgres',
    );
    await new Promise((r) => setTimeout(r, 2500)); // the image restarts the server once after initdb
    await waitUntil(
      () =>
        docker(
          'exec',
          names.postgres,
          'psql',
          '-U',
          'centcom',
          '-d',
          'centcom',
          '-tAc',
          'select 1',
        ).stdout.trim() === '1',
      'postgres (second start)',
    );
    const objectStore = {
      endpoint: `http://127.0.0.1:${minioPort}`,
      bucket: 'history',
      accessKey: 'loadtest',
      secretKey: 'loadtest-secret',
    };
    await waitUntil(
      () =>
        spawnSync('curl', [
          '-sf',
          '-o',
          '/dev/null',
          '--aws-sigv4',
          'aws:amz:us-east-1:s3',
          '--user',
          `${objectStore.accessKey}:${objectStore.secretKey}`,
          '-X',
          'PUT',
          `${objectStore.endpoint}/${objectStore.bucket}`,
        ]).status === 0,
      'minio',
    );
    const databaseUrl = `postgres://centcom:loadtest@127.0.0.1:${pgPort}/centcom`;
    const migrate = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'packages/db/src/cli.ts'), 'migrate'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          NODE_ENV: 'development',
          DATABASE_URL: databaseUrl,
          TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.test.json'),
        },
      },
    );
    if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
    return {
      redisUrl: `redis://127.0.0.1:${redisPort}/0`,
      databaseUrl,
      objectStore,
      containers: names,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}

/** CPU seconds and resident memory of a container, from `docker stats --no-stream`. */
export function containerStats(name: string): { cpuPercent: number; memMiB: number } {
  const r = docker('stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', name);
  const m = /([\d.]+)%\s+([\d.]+)(MiB|GiB|KiB)/.exec(r.stdout);
  if (m === null) return { cpuPercent: 0, memMiB: 0 };
  const mem = Number(m[2]) * (m[3] === 'GiB' ? 1024 : m[3] === 'KiB' ? 1 / 1024 : 1);
  return { cpuPercent: Number(m[1]), memMiB: mem };
}

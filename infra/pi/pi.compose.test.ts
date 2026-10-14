/**
 * The Pi test server's compose file (B112): it parses, every service has a memory limit and (but the one-shot
 * ones) a health check, the limits add up to under 3 GB, images are pinned, only Caddy and Mailpit publish ports
 * and nothing is published on a public interface by default beyond the LAN ones, secrets come from the generated
 * settings with a clear message, the optional edges sit behind profiles, and docker compose accepts it
 * (where Docker is installed).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;
const text = readFileSync(join(DIR, 'docker-compose.pi.yml'), 'utf8');
interface Service {
  image?: string;
  mem_limit?: string;
  healthcheck?: { test: unknown };
  ports?: string[];
  profiles?: string[];
  restart?: string;
  environment?: Record<string, string>;
  command?: unknown;
  depends_on?: Record<string, { condition: string }>;
}
const compose = parse(text, { merge: true }) as { services: Record<string, Service>; name: string };
const services = Object.entries(compose.services);
const ONE_SHOTS = ['minio-init', 'migrate'];
const MB = (value: string | undefined): number => {
  const m = /^(\d+)([mg])$/.exec(value ?? '');
  return m === null ? NaN : Number(m[1]) * (m[2] === 'g' ? 1024 : 1);
};
const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe('docker-compose.pi.yml', () => {
  it('has the services the card names: Postgres, Redis, API, relay, worker and Mailpit (and what they need)', () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      'api',
      'caddy',
      'caddy-tls',
      'cloudflared',
      'mailpit',
      'migrate',
      'minio',
      'minio-init',
      'postgres',
      'redis',
      'relay',
      'worker',
    ]);
  });

  it('gives every service a memory limit, and the default stack stays under 3 GB of limits', () => {
    for (const [name, s] of services)
      expect(MB(s.mem_limit), `${name} mem_limit`).toBeGreaterThan(0);
    const inDefault = services.filter(
      ([name, s]) => !ONE_SHOTS.includes(name) && (s.profiles ?? []).every((p) => p === 'lan'),
    );
    const total = inDefault.reduce((n, [, s]) => n + MB(s.mem_limit), 0);
    expect(total).toBeLessThan(3 * 1024);
    expect(total).toBeGreaterThan(1500); // a sanity floor: the limits are real, not zero-ish
  });

  it('gives every long-running service a health check, so up.sh can wait for them', () => {
    for (const [name, s] of services) {
      if (ONE_SHOTS.includes(name)) continue;
      expect(s.healthcheck?.test, `${name} healthcheck`).toBeDefined();
    }
  });

  it('pins every image to a tag other than latest', () => {
    for (const [name, s] of services) {
      if (s.image === undefined) continue;
      if (s.image.startsWith('centcom-')) continue; // built here, tagged by up.sh
      expect(s.image, name).toMatch(/:[A-Za-z0-9._-]+$/);
      expect(s.image, name).not.toMatch(/:latest$/);
    }
  });

  it('publishes only Caddy and Mailpit, and the plain router only on the loopback address', () => {
    const published = services
      .filter(([, s]) => s.ports !== undefined)
      .map(([name]) => name)
      .sort();
    expect(published).toEqual(['caddy', 'caddy-tls', 'mailpit']);
    expect(compose.services['caddy']?.ports?.every((p) => p.startsWith('127.0.0.1:'))).toBe(true);
    // the card: nothing for the internet; there is no port-forwarding step, and no 0.0.0.0 mapping of the databases
    for (const name of ['postgres', 'redis', 'minio', 'api', 'relay', 'worker'])
      expect(compose.services[name]?.ports).toBeUndefined();
  });

  it('keeps the TLS proxy behind the lan profile and the Cloudflare tunnel behind the tunnel profile', () => {
    expect(compose.services['caddy-tls']?.profiles).toEqual(['lan']);
    expect(compose.services['cloudflared']?.profiles).toEqual(['tunnel']);
    expect(compose.services['migrate']?.profiles).toEqual(['tools']);
  });

  it('sets the self-host plan and the mail catcher, uses production mode and no production template values', () => {
    const env = compose.services['api']?.environment ?? {};
    expect(env['SELF_HOST_PLAN']).toBe('team');
    expect(env['DEV_MAILPIT_URL']).toBe('http://mailpit:8025');
    expect(env['NODE_ENV']).toBe('production');
    expect(env['DEV_DEFAULT_PLAN']).toBeUndefined();
    expect(text).not.toMatch(/CHANGE_ME|GENERATE:/);
  });

  it('reads every secret from the generated settings, with a message that says to run up.sh', () => {
    for (const key of [
      'POSTGRES_PASSWORD',
      'REDIS_PASSWORD',
      'AUTH_SIGNING_KEYS',
      'IDEMPOTENCY_ENCRYPTION_KEY',
      'CURSOR_SIGNING_KEYS',
      'OBJECT_STORE_SECRET_ACCESS_KEY',
    ]) {
      expect(text, key).toMatch(new RegExp(`\\$\\{${key}:\\?run infra/pi/up\\.sh\\}`));
    }
    // no value is written into the file
    expect(text).not.toMatch(/(PASSWORD|SECRET|KEYS?): ['"]?[A-Za-z0-9+/=]{16,}/);
  });

  it('tunes Postgres and Redis for a small board', () => {
    const pg = (compose.services['postgres']?.command as string[]).join(' ');
    expect(pg).toContain('shared_buffers=128MB');
    expect(pg).toContain('max_connections=50');
    const redis = (compose.services['redis']?.command as string[]).join(' ');
    expect(redis).toContain('--maxmemory 128mb');
    expect(redis).toContain('noeviction'); // BullMQ needs it
    expect(redis).toContain('--appendonly no');
  });

  it.skipIf(spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0)(
    'is accepted by docker compose with a generated settings file, in every profile',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pi-compose-'));
      tmps.push(dir);
      const env = join(dir, 'pi.env');
      const gen = spawnSync('bash', [join(DIR, 'gen-env.sh'), env], { encoding: 'utf8' });
      expect(gen.status, gen.stderr).toBe(0);
      writeFileSync(
        env,
        `${readFileSync(env, 'utf8')}AUTH_SIGNING_KID=ktest\nAUTH_SIGNING_KEYS='[{"kty":"OKP"}]'\nPI_HOST=pi.local\nPI_PUBLIC_API_URL=https://pi.local\nPI_RELAY_PUBLIC_URL=wss://pi.local/v1/ws\n`,
      );
      const run = spawnSync(
        'docker',
        [
          'compose',
          '--project-name',
          'pitestparse',
          '--file',
          join(DIR, 'docker-compose.pi.yml'),
          '--env-file',
          env,
          '--profile',
          'lan',
          '--profile',
          'tools',
          '--profile',
          'tunnel',
          'config',
          '--quiet',
        ],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
    },
  );
});

/**
 * The production deploy files (B091, B092): the compose file publishes only Caddy's ports, pins its
 * images and gives each service only the secrets it reads; the images run as an unprivileged
 * user; the env template and `gen-env.mjs` agree with what compose requires and leave no
 * placeholder behind; the scripts parse and refuse an incomplete settings file. Needs no Docker
 * (the `docker compose config` check runs only where Docker is installed).
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;
const read = (name: string) => readFile(join(DIR, name), 'utf8');
const HAS_COMPOSE = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;

interface Service {
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  healthcheck?: unknown;
  security_opt?: string[];
  profiles?: string[];
  restart?: string;
  stop_grace_period?: string;
}
interface Compose {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
}

let compose: Compose;
let template: string;
let tmp: string;

beforeAll(async () => {
  compose = parse(await read('docker-compose.prod.yml'), { merge: true }) as Compose;
  template = await read('production.env.example');
  tmp = await mkdtemp(join(tmpdir(), 'deploy-test-'));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

const templateKeys = (): Set<string> =>
  new Set([...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? ''));

/** Runs gen-env.mjs writing to `out`. */
const genEnv = (out: string) =>
  spawnSync('node', [join(DIR, 'gen-env.mjs'), '--out', out], { encoding: 'utf8' });

describe('docker-compose.prod.yml', () => {
  it('publishes ports only from caddy (and the local-drill mail catcher, on loopback)', () => {
    const published = Object.entries(compose.services).filter(([, s]) => s.ports !== undefined);
    expect(published.map(([name]) => name).sort()).toEqual(['caddy', 'mailpit']);
    for (const port of compose.services['mailpit']?.ports ?? []) {
      expect(port).toMatch(/^127\.0\.0\.1:/);
    }
    expect(compose.services['mailpit']?.profiles).toEqual(['localmail']);
  });

  it('pins every image to a tag other than latest', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.image === undefined || service.image.startsWith('centcom-')) continue;
      expect(service.image, name).toMatch(/:[A-Za-z0-9][\w.-]*$/);
      expect(service.image, name).not.toMatch(/:latest$/);
    }
  });

  it('gives the long-running services a health check and no new privileges', () => {
    for (const name of ['postgres', 'redis', 'minio']) {
      expect(compose.services[name]?.healthcheck, name).toBeDefined();
    }
    // api and relay get theirs from the image (HEALTHCHECK in the Dockerfile).
    for (const name of ['caddy', 'api', 'worker', 'relay', 'postgres', 'redis', 'minio']) {
      expect(compose.services[name]?.security_opt, name).toContain('no-new-privileges:true');
      expect(compose.services[name]?.restart, name).toBe('unless-stopped');
    }
  });

  it('gives the relay time to drain (60 s) and keeps its secrets to what it reads', () => {
    expect(compose.services['relay']?.stop_grace_period).toBe('60s');
    const relayEnv = Object.keys(compose.services['relay']?.environment ?? {});
    for (const key of [
      'AUTH_SIGNING_KEYS',
      'IDEMPOTENCY_ENCRYPTION_KEY',
      'CURSOR_SIGNING_KEYS',
      'POSTMARK_SERVER_TOKEN',
    ]) {
      expect(relayEnv, key).not.toContain(key);
    }
    const minioEnv = JSON.stringify(compose.services['minio']?.environment);
    expect(minioEnv).not.toMatch(/POSTGRES|REDIS|SIGNING/);
  });

  it('runs the migration only as a one-shot behind the tools profile', () => {
    expect(compose.services['migrate']?.profiles).toEqual(['tools']);
    for (const name of ['api', 'worker', 'relay']) {
      expect(JSON.stringify(compose.services[name]), name).not.toContain('cli.js');
    }
  });

  it('requires every variable the template says is a secret, with a message', async () => {
    const raw = await read('docker-compose.prod.yml');
    const required = [...raw.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1] ?? '');
    expect(required.length).toBeGreaterThan(10);
    for (const key of required) expect(templateKeys(), key).toContain(key);
  });
});

describe('production.env.example and gen-env.mjs', () => {
  it('names every GENERATE secret with the services that read it', () => {
    const lines = template.split('\n');
    lines.forEach((line, i) => {
      if (/^[A-Z0-9_]+=GENERATE:/.test(line) && !line.startsWith('BACKUP_PASSPHRASE')) {
        // a comment block above the secret, or the bracket list in the group header
        expect(template, line).toMatch(/\[[a-z, ]+\]/);
        expect(i).toBeGreaterThan(0);
      }
    });
  });

  it('holds no real secret: only placeholders, empty values and harmless defaults', () => {
    expect(template).not.toMatch(/-----BEGIN|AKIA[0-9A-Z]{16}|sk-[a-z]{2,}-|"d":/);
  });

  it('writes a complete file with mode 600, never overwrites, and prints no secret', async () => {
    const out = join(tmp, 'production.env');
    const first = genEnv(out);
    expect(first.status).toBe(0);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const text = await readFile(out, 'utf8');
    expect(text).not.toMatch(/^[A-Z0-9_]+=GENERATE:/m);
    const secret = /^POSTGRES_PASSWORD=(.+)$/m.exec(text)?.[1] ?? '';
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(first.stdout + first.stderr).not.toContain(secret);
    // human-only values stay as placeholders
    expect(text).toMatch(/^API_HOST=CHANGE_ME$/m);
    // a second run refuses and leaves the file alone
    const again = genEnv(out);
    expect(again.status).toBe(1);
    expect(await readFile(out, 'utf8')).toBe(text);
  });

  it('writes keys the API accepts: a one-key Ed25519 JWK set and long cursor secrets', async () => {
    const out = join(tmp, 'keys.env');
    genEnv(out);
    const text = await readFile(out, 'utf8');
    const jwks = /^AUTH_SIGNING_KEYS='(.+)'$/m.exec(text)?.[1] ?? '';
    const keys = JSON.parse(jwks) as { kty: string; crv: string; kid: string; d: string }[];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(/^AUTH_SIGNING_KID=(.+)$/m.exec(text)?.[1]).toBe(keys[0]?.kid);
    const cursor = /^CURSOR_SIGNING_KEYS=(\w+):(.+)$/m.exec(text);
    expect((cursor?.[2] ?? '').length).toBeGreaterThanOrEqual(32);
    expect(
      Buffer.from(/^IDEMPOTENCY_ENCRYPTION_KEY=(.+)$/m.exec(text)?.[1] ?? '', 'base64'),
    ).toHaveLength(32);
  });

  it.skipIf(!HAS_COMPOSE)('makes a settings file that docker compose accepts', async () => {
    const out = join(tmp, 'filled.env');
    genEnv(out);
    const filled = (await readFile(out, 'utf8'))
      .replaceAll(/^API_HOST=.*$/gm, 'API_HOST=api.example.com')
      .replaceAll(/^RELAY_HOST=.*$/gm, 'RELAY_HOST=relay.example.com')
      .replaceAll(/^PUBLIC_API_URL=.*$/gm, 'PUBLIC_API_URL=https://api.example.com')
      .replaceAll(/^RELAY_PUBLIC_URL=.*$/gm, 'RELAY_PUBLIC_URL=wss://relay.example.com/v1/ws')
      .replaceAll(/^WEB_BASE_URL=.*$/gm, 'WEB_BASE_URL=https://centcom.dev')
      .replaceAll(
        /^LOGIN_RETURN_TO_ALLOWLIST=.*$/gm,
        'LOGIN_RETURN_TO_ALLOWLIST=https://api.example.com/device',
      )
      .replaceAll(/^ACME_EMAIL=.*$/gm, 'ACME_EMAIL=ops@example.com')
      .replaceAll(/^EMAIL_FROM=.*$/gm, 'EMAIL_FROM=Centcom <no-reply@example.com>');
    await writeFile(out, filled, { mode: 0o600 });
    const res = spawnSync(
      'docker',
      [
        'compose',
        '--file',
        join(DIR, 'docker-compose.prod.yml'),
        '--env-file',
        out,
        'config',
        '--quiet',
      ],
      { encoding: 'utf8' },
    );
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});

describe('Dockerfile', () => {
  it('runs every runtime target as the unprivileged node user, with a health check on the ports', async () => {
    const text = await read('Dockerfile');
    expect(text).toMatch(/FROM \$\{NODE_IMAGE\} AS runtime-base[\s\S]*?\nUSER node\n/);
    expect(text).not.toMatch(/^USER (root|0)\b/m);
    for (const target of ['api', 'worker', 'relay']) {
      expect(text, target).toMatch(new RegExp(`FROM runtime-base AS ${target}\\b`));
    }
    expect(text.match(/^HEALTHCHECK /gm)).toHaveLength(2);
    expect(text).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
  });

  it('pins the base image and bakes no secret into a layer', async () => {
    const text = await read('Dockerfile');
    expect(text).toMatch(/ARG NODE_IMAGE=node:22\.\d+\.\d+-/);
    expect(text).not.toMatch(/^(ENV|ARG) \w*(SECRET|PASSWORD|TOKEN|KEY)\w*[= ]/im);
  });
});

describe('the scripts', () => {
  const scripts = ['lib.sh', 'deploy.sh', 'migrate-safe.sh', 'rollback.sh', 'drill-token.sh'];

  it.each(scripts)('%s parses and stops on errors', async (name) => {
    expect(spawnSync('bash', ['-n', join(DIR, name)]).status).toBe(0);
    if (name !== 'lib.sh') expect(await read(name)).toMatch(/^set -euo pipefail$/m);
  });

  const run = (script: string, env: Record<string, string>, ...args: string[]) =>
    spawnSync('bash', [join(DIR, script), ...args], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DEPLOY_ENV_FILE: join(tmp, 'absent.env'),
        DEPLOY_STATE_DIR: join(tmp, 'state'),
        ...env,
      },
    });

  it('deploy.sh asks for a tag, rejects a bad one and an absent settings file with exit 2', () => {
    expect(run('deploy.sh', {}).status).toBe(2);
    expect(run('deploy.sh', {}, 'bad tag!').status).toBe(2);
    const missing = run(
      'deploy.sh',
      { DEPLOY_ENV_FILE: join(tmp, 'nope.env'), DEPLOY_STATE_DIR: tmp, DEPLOY_APPROVER: 'test' },
      'v1',
    );
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('gen-env.mjs');
  });

  it('refuses a settings file with placeholders or a loose mode, before touching Docker', async () => {
    const env = join(tmp, 'half.env');
    genEnv(env); // CHANGE_ME values remain
    const half = run(
      'deploy.sh',
      { DEPLOY_ENV_FILE: env, DEPLOY_STATE_DIR: tmp, DEPLOY_APPROVER: 'test' },
      'v1',
    );
    expect(half.status).toBe(2);
    expect(half.stderr).toMatch(/unfilled values on line/);
    await rm(env);
    await writeFile(env, 'API_HOST=x\n', { mode: 0o644 });
    const loose = run(
      'deploy.sh',
      { DEPLOY_ENV_FILE: env, DEPLOY_STATE_DIR: tmp, DEPLOY_APPROVER: 'test' },
      'v1',
    );
    expect(loose.status).toBe(2);
    expect(loose.stderr).toContain('mode 600');
  });

  it('rollback.sh needs a mode and a tag, and migrate-safe.sh rejects unknown options', () => {
    expect(run('rollback.sh', {}).status).toBe(2);
    expect(run('rollback.sh', { DEPLOY_STATE_DIR: join(tmp, 'empty') }, '--images').status).toBe(2);
    expect(run('migrate-safe.sh', {}, '--bogus').status).toBe(2);
  });

  it('drill-token.sh refuses a settings file that is not a localhost drill', async () => {
    const env = join(tmp, 'prod.env');
    await writeFile(env, 'PUBLIC_API_URL=https://api.example.com\n', { mode: 0o600 });
    const res = run('drill-token.sh', { DEPLOY_ENV_FILE: env }, 'usr_X', 'dev_X');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not a local drill');
  });
});

describe('Caddyfile', () => {
  it('trusts only Cloudflare ranges, hides the staff API, and sets one client address', async () => {
    const text = await read('Caddyfile');
    expect(text).toMatch(/trusted_proxies static 173\.245\.48\.0\/20/);
    expect(text).not.toMatch(/0\.0\.0\.0\/0|::\/0/);
    expect(text).toContain('/internal/admin/*');
    expect(text.match(/header_up X-Forwarded-For \{client_ip\}/g)).toHaveLength(2);
    expect(text).toContain('reverse_proxy api:3000');
    expect(text).toContain('reverse_proxy relay:8080');
  });

  it('limits request bodies (1 MiB for batch endpoints, 256 KiB elsewhere) and hides private paths first', async () => {
    const text = await read('Caddyfile');
    expect(text).toMatch(
      /@large path \/v1\/usage\/events \/v1\/telemetry \/internal\/stripe\/webhook/,
    );
    expect(text).toMatch(/max_size 1MiB/);
    expect(text).toMatch(/max_size 256KiB/);
    // the private-path handle block comes before the proxying ones, so it wins
    expect(text.indexOf('handle @private')).toBeLessThan(text.indexOf('handle @large'));
    expect(text.indexOf('handle @large')).toBeLessThan(
      text.indexOf('request_body {\n\t\t\tmax_size 256KiB'),
    );
  });
});

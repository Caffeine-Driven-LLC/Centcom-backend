/**
 * The one-container test server (B112, infra/aio): the Dockerfile is structurally sound (multi-stage, pinned bases,
 * every download has a sha256 for amd64 and arm64, the build stage equals the production one, no secret), the shell
 * scripts parse and shellcheck-style rules hold, the Caddyfiles name the right upstreams, and nothing secret or
 * key-looking is committed. `docker build` itself is run by hand (see docs/ops/test-server-container.md).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;
const read = (name: string, dir = DIR): string => readFileSync(join(dir, name), 'utf8');
const dockerfile = read('Dockerfile');
const SCRIPTS = [
  'entrypoint.sh',
  'healthcheck.sh',
  'run.sh',
  'stop.sh',
  'reset.sh',
  'test-token.sh',
  'lib.sh',
];
const FILES = [...SCRIPTS, 'Dockerfile', 'Caddyfile', 'Caddyfile.tls'];

/** A Dockerfile stage from its FROM line to the next FROM (without comments and blank lines). */
function stage(text: string, name: string): string {
  const parts = text.split(/^(?=FROM )/m);
  const part = parts.find((p) => new RegExp(`^FROM .* AS ${name}\\s*$`, 'm').test(p));
  if (part === undefined) throw new Error(`no stage ${name}`);
  return part
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .join('\n');
}

describe('infra/aio/Dockerfile', () => {
  it('is multi-stage with a runtime stage and pinned bases (tag and digest)', () => {
    expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(5);
    for (const arg of ['NODE_IMAGE', 'POSTGRES_IMAGE', 'REDIS_IMAGE', 'MINIO_IMAGE']) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=\\S+:[\\w.-]+@sha256:[0-9a-f]{64}$`, 'm'));
    }
    expect(dockerfile).not.toMatch(/:latest\b/);
  });

  it('uses the production build stage of infra/deploy/Dockerfile, unchanged', () => {
    const prod = read('Dockerfile', join(DIR, '..', 'deploy'));
    expect(stage(dockerfile, 'build')).toBe(stage(prod, 'build'));
    // the base images must agree on the Node version too
    const nodeVersion = (t: string): string | undefined =>
      /node:([\d.]+)-bookworm-slim/.exec(t)?.[1];
    expect(nodeVersion(dockerfile)).toBe(nodeVersion(prod));
  });

  it('has a sha256 for every download and an arm64 and an amd64 value of each', () => {
    for (const tool of ['MAILPIT', 'CADDY']) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${tool}_VERSION=\\d+\\.\\d+\\.\\d+$`, 'm'));
      const amd = new RegExp(`^ARG ${tool}_SHA256_AMD64=([0-9a-f]{64})$`, 'm').exec(
        dockerfile,
      )?.[1];
      const arm = new RegExp(`^ARG ${tool}_SHA256_ARM64=([0-9a-f]{64})$`, 'm').exec(
        dockerfile,
      )?.[1];
      expect(amd).toBeDefined();
      expect(arm).toBeDefined();
      expect(amd).not.toBe(arm);
    }
    // every curl download is checked before it is installed
    expect(dockerfile.match(/curl -fsSL -o/g)?.length).toBe(2);
    expect(dockerfile.match(/sha256sum -c -/g)?.length).toBe(2);
    expect(dockerfile).toContain('TARGETARCH');
    expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  it('runs tini as PID 1 without -g (the entrypoint stops services in order), has a HEALTHCHECK, no secrets', () => {
    expect(dockerfile).toMatch(
      /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/entrypoint.sh"\]/,
    );
    expect(dockerfile).toMatch(/^HEALTHCHECK .*healthcheck\.sh/m);
    expect(dockerfile).toMatch(/^VOLUME \/data$/m);
    expect(dockerfile).not.toMatch(/^ENV .*(PASSWORD|SECRET|TOKEN|PRIVATE)/im);
    for (const port of [3000, 8088, 8025, 8080, 9001])
      expect(dockerfile).toMatch(new RegExp(`EXPOSE .*\\b${port}\\b`));
  });

  it('copies only files that exist, and only the files it needs', () => {
    for (const m of dockerfile.matchAll(/^COPY (?!--from)(?!\. )(\S+) /gm)) {
      expect(statSync(join(DIR, '..', '..', m[1] as string)).isFile()).toBe(true);
    }
  });
});

describe('shell scripts', () => {
  for (const name of SCRIPTS) {
    it(`${name} parses (bash -n)`, () => {
      const r = spawnSync('bash', ['-n', join(DIR, name)], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  }

  it('the executable ones are executable and strict', () => {
    for (const name of SCRIPTS.filter((n) => n !== 'lib.sh')) {
      expect(statSync(join(DIR, name)).mode & 0o111, name).not.toBe(0);
      expect(read(name)).toMatch(/^set -[euo]+/m);
      expect(read(name).startsWith('#!/usr/bin/env bash')).toBe(true);
    }
  });

  it('entrypoint: generates secrets at start (mode 600), migrates, makes buckets, stops in reverse order', () => {
    const e = read('entrypoint.sh');
    expect(e).toContain('rand_hex 24');
    expect(e).toContain('umask 077');
    expect(e).toMatch(/node_modules\/@centcom\/db\/dist\/cli\.js migrate/);
    expect(e).toContain('minio-init.sh');
    expect(e).toMatch(/SELF_HOST_PLAN="\$PLAN"/);
    expect(e).toMatch(/PLAN="\$\{SELF_HOST_PLAN:-team\}"/);
    expect(e).toMatch(/for \(\(i = \$\{#ORDER\[@\]\} - 1; i >= 0; i--\)\)/);
    expect(e).toContain('trap on_signal TERM INT');
    // Postgres gets SIGINT (fast shutdown): SIGTERM would wait for every client to leave
    expect(e).toMatch(/supervise postgres INT /);
    // services other than Postgres do not run as root
    expect(
      e.match(/supervise (redis|minio|mailpit|api|worker|relay|caddy) TERM gosu centcom/g)?.length,
    ).toBe(7);
  });

  it('entrypoint: Postgres, Redis and the mail port listen on loopback only (MinIO is published for presigned URLs)', () => {
    const e = read('entrypoint.sh');
    for (const bind of [
      'listen_addresses=127.0.0.1',
      '--bind 127.0.0.1',
      '--address 0.0.0.0:$S3_PORT',
      '--smtp 127.0.0.1:1025',
    ]) {
      expect(e).toContain(bind);
    }
  });

  it('run.sh: refuses plain http for another host, labels the container, touches only its own', () => {
    const run = read('run.sh');
    expect(run).toMatch(/needs --tls/);
    expect(run).toContain('--label dev.centcom.aio=1');
    expect(run).toMatch(/--health-cmd/);
    expect(run).toMatch(/--name "\$AIO_NAME"/);
    expect(read('lib.sh')).toContain('dev.centcom.aio');
    for (const name of ['stop.sh', 'reset.sh']) expect(read(name)).toContain('is_ours');
    expect(run).not.toMatch(/docker (kill|system prune|rm -f)/);
    expect(run).toMatch(/127\.0\.0\.1/);
  });

  it('run.sh --help and a bad option exit as documented (no Docker needed)', () => {
    const help = spawnSync('bash', [join(DIR, 'run.sh'), '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--tls');
    const bad = spawnSync('bash', [join(DIR, 'run.sh'), '--nope'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    const lan = spawnSync('bash', [join(DIR, 'run.sh'), '--host', 'pi.local'], {
      encoding: 'utf8',
    });
    expect(lan.status).toBe(2);
    expect(lan.stderr).toContain('--tls');
  });
});

describe('Caddyfiles', () => {
  it('route /v1/ws to the relay and the rest to the API, on loopback upstreams', () => {
    for (const name of ['Caddyfile', 'Caddyfile.tls']) {
      const c = read(name);
      expect(c).toContain('reverse_proxy 127.0.0.1:8088');
      expect(c).toContain('reverse_proxy 127.0.0.1:3000');
      expect(c).toContain('/v1/ws');
    }
    expect(read('Caddyfile')).toMatch(/^:8080 \{/m);
    expect(read('Caddyfile')).toContain('admin off');
  });

  it('the HTTPS mode serves its CA certificate over plain HTTP and nothing else', () => {
    const t = read('Caddyfile.tls');
    expect(t).toContain('tls internal');
    expect(t).toContain('/ca.crt');
    expect(t).toMatch(/respond ".*" 404/);
  });
});

describe('committed files', () => {
  const keyish = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /"d"\s*:\s*"[A-Za-z0-9_-]{30,}"/,
    /^\s*(?:[A-Z_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*)=['"]?[A-Za-z0-9+/_-]{16,}/m,
  ];
  it('hold no secret or key-looking value, and no generated state', () => {
    const files = readdirSync(DIR).filter((f) => !f.startsWith('.'));
    for (const f of files) {
      const text = read(f);
      for (const re of keyish) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
    expect(files.sort()).toEqual([...FILES, 'aio.test.ts'].sort());
  });

  it('the generated secrets are made by the entrypoint from /dev/urandom, not stored', () => {
    expect(read('entrypoint.sh')).toContain('/dev/urandom');
    expect(read('entrypoint.sh')).not.toMatch(/(PASSWORD|SECRET)[A-Z_]*=["']?[0-9a-f]{24,}/);
  });
});

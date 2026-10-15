/**
 * The deploy pipeline's checks (B092):
 * - smoke.mjs against a fake API and relay: every check passes, or exit 20 naming each one that
 *   failed (unhealthy readyz, no JWKS key, refused upgrade, a dead relay);
 * - slo-guard.mjs over Caddy's per-host metrics: within the SLO; an injected 5 % of 5xx is a
 *   breach (exit 30); p95 over 2x the baseline; too little traffic passes; counters that reset
 *   start over; unreadable metrics breach in production and only warn in stage;
 * - release-gate.mjs: production needs a fresh, green conformance report for the commit and the
 *   stage record (exit 10 otherwise); stage needs the report only when required;
 * - deploy.sh refuses a bad --env, a production deploy without an approver, and --skip-slo in
 *   production, before touching Docker;
 * - compose's deploy-check mounts only the scripts; Caddy's metrics listener is not published.
 * No Docker is needed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseChecks } from './release-gate.mjs';
import { delta, guard, judge, p95, snapshotOf } from './slo-guard.mjs';
import { runSmoke } from './smoke.mjs';

const DIR = import.meta.dirname;
let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** Runs a command without blocking this process's event loop (the fake servers live here). */
function runAsync(cmd: string, args: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

/** An HTTP server answering with `handler`; upgrades answered 101 unless `refuseUpgrade`. */
async function fakeServer(
  handler: (path: string, method: string) => { status: number; body?: unknown },
  opts: { refuseUpgrade?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const r = handler(req.url ?? '/', req.method ?? 'GET');
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(
      r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
    );
  });
  server.on('upgrade', (_req, socket) => {
    socket.end(
      opts.refuseUpgrade
        ? 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'
        : 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const healthy = (path: string, method: string) => {
  if (path === '/healthz' || path === '/readyz') return { status: 200, body: { ok: true } };
  if (path === '/v1/status') return { status: 200, body: { status: 'operational' } };
  if (path === '/.well-known/jwks.json') return { status: 200, body: { keys: [{ kid: 'k1' }] } };
  if (path === '/v1/auth/device/code' && method === 'POST') {
    return { status: 200, body: { device_code: 'd', user_code: 'ABCD-EFGH' } };
  }
  return { status: 404 };
};

describe('smoke.mjs', () => {
  it('passes every check against a healthy API and relay', async () => {
    const api = await fakeServer(healthy);
    try {
      const results = await runSmoke({
        api: api.url,
        relay: `${api.url.replace('http', 'ws')}/v1/ws`,
        timeoutMs: 2000,
      });
      expect(results.map((r) => [r.check, r.ok])).toEqual([
        ['healthz', true],
        ['readyz', true],
        ['status', true],
        ['jwks', true],
        ['device-code', true],
        ['relay-upgrade', true],
      ]);
    } finally {
      await api.close();
    }
  });

  it('names each failing check, and the command exits 20', async () => {
    const api = await fakeServer(
      (path, method) =>
        path === '/readyz'
          ? { status: 503 }
          : path === '/.well-known/jwks.json'
            ? { status: 200, body: { keys: [] } }
            : healthy(path, method),
      { refuseUpgrade: true },
    );
    try {
      const results = await runSmoke({
        api: api.url,
        relay: api.url.replace('http', 'ws'),
        timeoutMs: 2000,
      });
      expect(results.filter((r) => !r.ok).map((r) => r.check)).toEqual([
        'readyz',
        'jwks',
        'relay-upgrade',
      ]);
      const cli = await runAsync('node', [
        join(DIR, 'smoke.mjs'),
        '--api',
        api.url,
        '--relay',
        api.url.replace('http', 'ws'),
        '--timeout-ms',
        '2000',
      ]);
      expect(cli.status).toBe(20);
      expect(cli.stdout).toContain('"smoke":"fail"');
    } finally {
      await api.close();
    }
  });

  it('a relay that is down fails relay-upgrade; bad arguments exit 2', async () => {
    const api = await fakeServer(healthy);
    try {
      const results = await runSmoke({
        api: api.url,
        relay: 'ws://127.0.0.1:1/v1/ws',
        timeoutMs: 1000,
      });
      expect(results.find((r) => r.check === 'relay-upgrade')?.ok).toBe(false);
    } finally {
      await api.close();
    }
    expect(spawnSync('node', [join(DIR, 'smoke.mjs')], { encoding: 'utf8' }).status).toBe(2);
  });
});

/** Caddy metrics text for `host`: `ok` and `errors` requests, all in the bucket at `le`. */
function metrics(rows: { host: string; ok: number; errors: number; le: number }[]): string {
  const lines = ['# TYPE caddy_http_request_duration_seconds histogram'];
  for (const r of rows) {
    for (const [code, n] of [
      ['200', r.ok],
      ['502', r.errors],
    ] as const) {
      const labels = `code="${code}",handler="reverse_proxy",host="${r.host}",method="GET",server="srv0"`;
      for (const le of ['0.05', '0.1', '0.25', '0.5', '1', '+Inf']) {
        const inBucket = Number(le === '+Inf' ? Infinity : le) >= r.le ? n : 0;
        lines.push(`caddy_http_request_duration_seconds_bucket{${labels},le="${le}"} ${inBucket}`);
      }
      lines.push(`caddy_http_request_duration_seconds_count{${labels}} ${n}`);
    }
  }
  return lines.join('\n');
}

describe('slo-guard.mjs', () => {
  const HOST = 'api.example.com';

  it('reads per-host counters and computes p95 from the buckets', () => {
    const snap = snapshotOf(
      metrics([
        { host: HOST, ok: 90, errors: 10, le: 0.1 },
        { host: 'relay.example.com', ok: 500, errors: 500, le: 1 },
      ]),
      HOST,
    );
    expect(snap.total).toBe(100);
    expect(snap.errors).toBe(10);
    expect(p95(snap)).toBe(0.1);
  });

  it('judges: within the SLO, 5 % 5xx breaches, p95 over 2x the baseline breaches, little traffic passes', () => {
    const base = snapshotOf(metrics([{ host: HOST, ok: 1000, errors: 0, le: 0.1 }]), HOST);
    const at = (ok: number, errors: number, le: number) =>
      snapshotOf(metrics([{ host: HOST, ok, errors, le }]), HOST);
    expect(judge(at(200, 1, 0.1), base, 20)).toMatchObject({ breach: false, reason: 'ok' });
    expect(judge(at(190, 10, 0.1), base, 20)).toMatchObject({ breach: true, reason: 'error_rate' });
    expect(judge(at(200, 0, 0.5), base, 20)).toMatchObject({ breach: true, reason: 'latency' });
    expect(judge(at(10, 5, 1), base, 20)).toMatchObject({
      breach: false,
      reason: 'too_little_traffic',
    });
    // Counters that went backwards: a restart.
    expect(delta(at(5, 0, 0.1), at(50, 0, 0.1))).toBeNull();
  });

  it('an injected 5 % of 5xx during the window: exit 30 (deploy.sh rolls back)', async () => {
    let calls = 0;
    const server = await fakeServer((path) => {
      if (path !== '/metrics') return { status: 404 };
      calls += 1;
      const rows =
        calls === 1
          ? [{ host: HOST, ok: 1000, errors: 0, le: 0.1 }]
          : [{ host: HOST, ok: 1095, errors: 5, le: 0.1 }];
      return { status: 200, body: metrics(rows) };
    });
    try {
      const code = await guard(
        {
          metrics: `${server.url}/metrics`,
          host: HOST,
          env: 'stage',
          window: 60,
          interval: 15,
          minRequests: 20,
          baseline: null,
        },
        () => Promise.resolve(),
      );
      expect(code).toBe(30);
    } finally {
      await server.close();
    }
  });

  it('a clean window passes; unreadable metrics breach in production and warn in stage', async () => {
    let n = 1000;
    const server = await fakeServer((path) => {
      if (path !== '/metrics') return { status: 404 };
      n += 100;
      return { status: 200, body: metrics([{ host: HOST, ok: n, errors: 0, le: 0.05 }]) };
    });
    try {
      const opts = {
        metrics: `${server.url}/metrics`,
        host: HOST,
        window: 0,
        interval: 15,
        minRequests: 20,
        baseline: null,
      };
      expect(await guard({ ...opts, env: 'production' }, () => Promise.resolve())).toBe(0);
    } finally {
      await server.close();
    }
    const dead = {
      metrics: 'http://127.0.0.1:1/metrics',
      host: HOST,
      window: 0,
      interval: 1,
      minRequests: 20,
      baseline: null,
    };
    expect(await guard({ ...dead, env: 'production' }, () => Promise.resolve())).toBe(30);
    expect(await guard({ ...dead, env: 'stage' }, () => Promise.resolve())).toBe(0);
  });
});

describe('release-gate.mjs', () => {
  const NOW = Date.parse('2026-10-14T12:00:00Z');
  const SHA = 'a'.repeat(40);
  const report = (extra: Record<string, unknown> = {}) => ({
    generated_at: new Date(NOW - 3_600_000).toISOString(),
    git_sha: SHA,
    summary: { failed: 0, cases_total: 400 },
    ...extra,
  });
  const write = async (name: string, value: unknown) => {
    const path = join(tmp, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const failing = (checks: { check: string; ok: boolean }[]) =>
    checks.filter((c) => !c.ok).map((c) => c.check);

  it('production passes with a fresh green report for the commit and the stage record', async () => {
    const conformance = await write('ok.json', report());
    const stageRecord = await write('stage.json', {
      env: 'stage',
      result: 'deployed',
      git_sha: SHA,
    });
    expect(
      failing(
        releaseChecks({
          env: 'production',
          gitSha: SHA,
          conformance,
          stageRecord,
          now: NOW,
          requireConformance: false,
        }),
      ),
    ).toEqual([]);
  });

  it('production refuses a missing, stale, failed or other-commit report, and a missing stage record', async () => {
    const stageRecord = await write('stage2.json', {
      env: 'stage',
      result: 'deployed',
      git_sha: SHA,
    });
    const base = {
      env: 'production',
      gitSha: SHA,
      stageRecord,
      now: NOW,
      requireConformance: false,
    };
    expect(failing(releaseChecks({ ...base, conformance: join(tmp, 'absent.json') }))).toEqual([
      'conformance report present',
    ]);
    expect(
      failing(
        releaseChecks({
          ...base,
          conformance: await write(
            'stale.json',
            report({ generated_at: new Date(NOW - 25 * 3_600_000).toISOString() }),
          ),
        }),
      ),
    ).toEqual(['conformance report is less than 24 h old']);
    expect(
      failing(
        releaseChecks({
          ...base,
          conformance: await write(
            'red.json',
            report({ summary: { failed: 2, cases_total: 400 } }),
          ),
        }),
      ),
    ).toEqual(['conformance report has no failure']);
    expect(
      failing(
        releaseChecks({
          ...base,
          conformance: await write('other.json', report({ git_sha: 'b'.repeat(40) })),
        }),
      ),
    ).toEqual(['conformance report is for this commit']);
    const conformance = await write('ok2.json', report());
    expect(failing(releaseChecks({ ...base, conformance, stageRecord: undefined }))).toEqual([
      'stage deployed this commit',
    ]);
    const failedStage = await write('stage3.json', {
      env: 'stage',
      result: 'slo_breach',
      git_sha: SHA,
    });
    expect(failing(releaseChecks({ ...base, conformance, stageRecord: failedStage }))).toEqual([
      'stage deployed this commit',
    ]);
  });

  it('stage needs the report only when required; the command exits 10 on a failure', async () => {
    const absent = join(tmp, 'none.json');
    expect(
      releaseChecks({
        env: 'stage',
        gitSha: SHA,
        conformance: absent,
        now: NOW,
        requireConformance: false,
      }),
    ).toEqual([]);
    expect(
      failing(
        releaseChecks({
          env: 'stage',
          gitSha: SHA,
          conformance: absent,
          now: NOW,
          requireConformance: true,
        }),
      ),
    ).toEqual(['conformance report present']);
    const cli = spawnSync(
      'node',
      [
        join(DIR, 'release-gate.mjs'),
        '--env',
        'production',
        '--git-sha',
        SHA,
        '--conformance',
        absent,
      ],
      { encoding: 'utf8' },
    );
    expect(cli.status).toBe(10);
    expect(
      spawnSync('node', [join(DIR, 'release-gate.mjs'), '--env', 'prod'], { encoding: 'utf8' })
        .status,
    ).toBe(2);
  });
});

describe('deploy.sh and the compose file', () => {
  const run = (...args: string[]) =>
    spawnSync('bash', [join(DIR, 'deploy.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', DEPLOY_STATE_DIR: join(tmp, 'state') },
    });

  it('refuses a bad --env, production without an approver, and --skip-slo in production (exit 2)', () => {
    expect(run('v2', '--env', 'prod').status).toBe(2);
    const unapproved = run('v2', '--env', 'production');
    expect(unapproved.status).toBe(2);
    expect(unapproved.stderr).toContain('--approved-by');
    const skipped = run('v2', '--env', 'production', '--approved-by', 'Ada', '--skip-slo');
    expect(skipped.status).toBe(2);
    expect(skipped.stderr).toContain('stage only');
    expect(run('v2', '--env', 'stage', '--slo-window', 'soon').status).toBe(2);
  });

  it('deploy-check mounts only the two scripts and carries no secret; the metrics port is not published', async () => {
    const compose = parse(await readFile(join(DIR, 'docker-compose.prod.yml'), 'utf8'), {
      merge: true,
    }) as {
      services: Record<
        string,
        { profiles?: string[]; volumes?: string[]; environment?: unknown; ports?: string[] }
      >;
    };
    const check = compose.services['deploy-check'];
    expect(check?.profiles).toEqual(['tools']);
    expect(check?.volumes).toEqual([
      './smoke.mjs:/deploy/smoke.mjs:ro',
      './slo-guard.mjs:/deploy/slo-guard.mjs:ro',
    ]);
    expect(check?.environment).toBeUndefined();
    expect(JSON.stringify(compose.services['caddy']?.ports ?? [])).not.toContain('9180');
    const caddyfile = await readFile(join(DIR, 'Caddyfile'), 'utf8');
    expect(caddyfile).toMatch(/metrics \{\s*per_host\s*\}/);
    expect(caddyfile).toMatch(/:9180 \{\s*metrics \/metrics\s*\}/);
  });
});

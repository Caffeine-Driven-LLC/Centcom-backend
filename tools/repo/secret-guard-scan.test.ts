/**
 * `secret-guard-scan` (B101, surface 4): exit codes and output on a planted tree, a log folder
 * and a dump; no matched text is ever printed; the real repository is clean.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'tools', 'repo', 'secret-guard-scan.ts');
const AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const ANTHROPIC = ['sk-ant-', 'api03-', 'A'.repeat(24)].join('');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'guard-scan-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function scan(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: tmp,
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.test.json'),
    },
    timeout: 120_000,
  });
}

function tree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

describe('secret-guard-scan', { timeout: 120_000 }, () => {
  it('exits 1 on a planted key, printing path:line pattern-id and no matched text', () => {
    const dir = tree('planted', {
      'src/a.ts': `const ok = 1;\n\nconst key = '${AWS}';\n`,
      'src/b.ts': 'fine\n',
    });
    const res = scan('--root', dir);
    expect(res.status).toBe(1);
    expect(res.stdout.trim()).toBe('src/a.ts:3 aws_access_key');
    expect(res.stdout + res.stderr).not.toContain('AKIA');
  });

  it('exits 0 on a clean tree and skips binary files and node_modules', () => {
    const dir = tree('clean', { 'a.txt': 'hello\n', 'node_modules/x/y.js': `'${AWS}'\n` });
    writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(AWS)]));
    const res = scan('--root', dir);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('clean');
  });

  it('honours the root allow-list: a scoped entry hides docs/, not src/', () => {
    const entry = {
      pattern_id: 'aws_access_key',
      scope: 'path',
      value: 'docs/',
      reason: 'examples',
      expires: '2999-01-01',
    };
    const dir = tree('allowed', {
      'secret-guard.allow.json': JSON.stringify({ entries: [entry] }),
      'docs/x.md': AWS,
      'src/x.ts': AWS,
    });
    const res = scan('--root', dir);
    expect(res.status).toBe(1);
    expect(res.stdout.trim()).toBe('src/x.ts:1 aws_access_key');
  });

  it('exits 2 for a broken allow-list, a missing folder and unknown arguments', () => {
    const dir = tree('broken', {
      'secret-guard.allow.json': '{"entries":[{"pattern_id":"aws_access_key"}]}',
    });
    expect(scan('--root', dir).status).toBe(2);
    expect(scan('--root', join(tmp, 'nope')).status).toBe(2);
    expect(scan('--bogus').status).toBe(2);
    expect(scan('--root').status).toBe(2);
  });

  it('scans a log folder and a dump, and prints locations only', () => {
    const logs = tree('logs', { 'api.log': `{"msg":"x"}\n{"token":"${ANTHROPIC}"}\n` });
    const dumpDir = tree('dump', {
      'db.sql': `${'-- filler\n'.repeat(20_000)}COPY t FROM stdin;\n${AWS}\n`,
    });
    const clean = tree('clean2', { 'a.txt': 'x' });
    const logRun = scan('--root', clean, '--logs', logs);
    expect(logRun.status).toBe(1);
    expect(logRun.stdout.trim()).toBe('logs/api.log:2 anthropic_api_key');
    const dumpRun = scan('--root', clean, '--dump', join(dumpDir, 'db.sql'));
    expect(dumpRun.status).toBe(1);
    expect(dumpRun.stdout.trim()).toBe(
      `dump:${'-- filler\n'.length * 20_000 + 'COPY t FROM stdin;\n'.length} aws_access_key`,
    );
    expect(logRun.stdout + dumpRun.stdout + logRun.stderr + dumpRun.stderr).not.toMatch(
      /AKIA|sk-ant/,
    );
    expect(scan('--root', clean, '--json', '--logs', logs).stdout).toBe(
      '[{"where":"logs/api.log:2","pattern":"anthropic_api_key"}]\n',
    );
  });

  it('is clean on this repository, whose only credential-shaped text is covered by scoped entries', () => {
    const res = scan();
    expect(res.stdout).toBe('');
    expect(res.status).toBe(0);
  });
});

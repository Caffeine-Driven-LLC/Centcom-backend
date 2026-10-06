/**
 * B001 repo layout: every workspace exists with the expected manifest, and the shared
 * toolchain settings the acceptance criteria rely on are present.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;

const WORKSPACES: Record<string, string> = {
  'apps/api': '@centcom/api',
  'apps/relay': '@centcom/relay',
  'apps/worker': '@centcom/worker',
  'apps/admin': '@centcom/admin',
  'packages/contracts': '@centcom/contracts',
  'packages/core': '@centcom/core',
  'packages/db': '@centcom/db',
  'packages/testkit': '@centcom/testkit',
};

describe('workspaces', () => {
  for (const [dir, name] of Object.entries(WORKSPACES)) {
    it(`${dir} is ${name}, private, ESM, Node 22, exports map only`, () => {
      const pkg = readJson(`${dir}/package.json`);
      expect(pkg.name).toBe(name);
      expect(pkg.private).toBe(true);
      expect(pkg.type).toBe('module');
      expect(pkg.engines).toEqual({ node: '>=22 <23' });
      expect(pkg.exports).toHaveProperty('.');
      expect(pkg).not.toHaveProperty('main');
      expect(existsSync(join(root, dir, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(root, dir, 'tsconfig.json'))).toBe(true);
    });
  }

  it('pnpm-workspace.yaml covers apps/* and packages/*', () => {
    const yaml = read('pnpm-workspace.yaml');
    expect(yaml).toMatch(/^\s+- apps\/\*$/m);
    expect(yaml).toMatch(/^\s+- packages\/\*$/m);
  });

  it('the root solution tsconfig references every workspace', () => {
    const refs = (readJson('tsconfig.json').references as { path: string }[]).map((r) => r.path);
    expect(refs.sort()).toEqual(Object.keys(WORKSPACES).sort());
  });

  it('no workspace carries its own lint config (one root config is the source of truth)', () => {
    for (const dir of Object.keys(WORKSPACES)) {
      for (const f of [
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.ts',
        '.eslintrc.json',
      ]) {
        expect(existsSync(join(root, dir, f)), `${dir}/${f}`).toBe(false);
      }
    }
  });
});

describe('root toolchain', () => {
  it('pins Node 22 and an exact pnpm version', () => {
    const pkg = readJson('package.json');
    expect(pkg.engines).toEqual({ node: '>=22 <23' });
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(read('.node-version').trim()).toBe('22');
  });

  it('exposes the root scripts other lanes rely on', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    for (const s of [
      'build',
      'typecheck',
      'lint',
      'test',
      'format',
      'contracts:gen',
      'contracts:check',
      'dev:up',
    ]) {
      expect(scripts, s).toHaveProperty(s);
    }
    expect(scripts['dev:up']).toBe('bash tools/dev/up.sh');
  });

  it('tsconfig.base.json is strict ESM NodeNext with noUncheckedIndexedAccess', () => {
    const opts = readJson('tsconfig.base.json').compilerOptions as Record<string, unknown>;
    expect(opts).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2023',
    });
  });

  it('blocks dependency lifecycle scripts and enforces engines', () => {
    expect(read('.npmrc')).toMatch(/^ignore-scripts=true$/m);
    const yaml = read('pnpm-workspace.yaml');
    expect(yaml).toMatch(/^ignoreScripts: true$/m);
    expect(yaml).toMatch(/^engineStrict: true$/m);
  });

  it('pnpm itself resolves ignoreScripts to true', { timeout: 30_000 }, () => {
    const r = spawnSync('pnpm', ['config', 'get', 'ignoreScripts'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });
});

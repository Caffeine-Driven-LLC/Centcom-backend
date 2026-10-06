/**
 * B001 lint and typecheck guards: the fixtures in tools/lint-fixtures must fail (or pass)
 * when ESLint and tsc run on them as if they lived at the given repo path.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const eslintBin = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const TIMEOUT = 60_000;

function lintAs(fixture: string, asPath: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [eslintBin, '--stdin', '--stdin-filename', asPath], {
    cwd: root,
    input: readFileSync(join(root, 'tools', 'lint-fixtures', fixture), 'utf8'),
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  return { status: r.status, output: r.stdout + r.stderr };
}

describe('lint fixtures', () => {
  it('explicit any in packages/core/src fails', { timeout: TIMEOUT }, () => {
    const r = lintAs('any.ts', 'packages/core/src/any.ts');
    expect(r.status).toBe(1);
    expect(r.output).toContain('@typescript-eslint/no-explicit-any');
  });

  it('console.log in packages/core/src fails', { timeout: TIMEOUT }, () => {
    const r = lintAs('console.ts', 'packages/core/src/console.ts');
    expect(r.status).toBe(1);
    expect(r.output).toContain('no-console');
  });

  it('console.log in a non-entrypoint app file fails', { timeout: TIMEOUT }, () => {
    const r = lintAs('console.ts', 'apps/api/src/server.ts');
    expect(r.status).toBe(1);
    expect(r.output).toContain('no-console');
  });

  it('console.log in an app entrypoint (apps/*/src/main.ts) passes', { timeout: TIMEOUT }, () => {
    const r = lintAs('entrypoint-console.ts', 'apps/api/src/main.ts');
    expect(r.output).not.toContain('no-console');
    expect(r.status).toBe(0);
  });

  it('a cross-package deep import fails', { timeout: TIMEOUT }, () => {
    const r = lintAs('deep-import.ts', 'packages/db/src/deep.ts');
    expect(r.status).toBe(1);
    expect(r.output).toContain('no-restricted-imports');
  });
});

describe('environment access (B004)', () => {
  for (const [fixture, rule] of [
    ['process-env.ts', 'no-restricted-properties'],
    ['process-env-destructure.ts', 'no-restricted-properties'],
    ['process-env-import.ts', 'no-restricted-imports'],
    ['process-env-alias.ts', 'no-restricted-syntax'],
    ['process-env-global.ts', 'no-restricted-syntax'],
    ['process-env-computed.ts', 'no-restricted-syntax'],
  ] as const) {
    it(`${fixture} fails outside the config loader and entrypoints`, { timeout: TIMEOUT }, () => {
      for (const asPath of [
        'packages/db/src/env.ts',
        'apps/api/src/server.ts',
        'packages/core/test/config/env.test.ts',
      ]) {
        const r = lintAs(fixture, asPath);
        expect(r.status, asPath).toBe(1);
        expect(r.output, asPath).toContain(rule);
      }
    });
  }

  it(
    'the config loader, entrypoints and repo tooling may read the environment',
    { timeout: TIMEOUT },
    () => {
      for (const asPath of [
        'packages/core/src/config/env.ts',
        'apps/api/src/main.ts',
        'tools/ci/env.mjs',
      ]) {
        expect(lintAs('process-env.ts', asPath).status, asPath).toBe(0);
      }
    },
  );
});

describe('typecheck fixture', () => {
  it('an implicit any fails tsc under tsconfig.base.json', { timeout: TIMEOUT }, () => {
    const r = spawnSync(process.execPath, [tscBin, '-p', 'tools/lint-fixtures/implicit-any'], {
      cwd: root,
      encoding: 'utf8',
      timeout: TIMEOUT,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('TS7006');
  });
});

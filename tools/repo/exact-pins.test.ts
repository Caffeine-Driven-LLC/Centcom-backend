/** B001 exact pins: no package.json in the repo may use a version range. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRangeViolations, isExactSpec } from './check-exact-pins.mjs';

const root = join(import.meta.dirname, '..', '..');

describe('isExactSpec', () => {
  it.each(['5.9.3', '1.0.0-rc.1', '2.0.0+build.5', 'workspace:*', 'npm:@scope/pkg@1.2.3'])(
    'accepts %s',
    (spec) => expect(isExactSpec(spec)).toBe(true),
  );
  it.each([
    '^5.9.3',
    '~5.9.3',
    '*',
    '>=5',
    '5.x',
    '5',
    'latest',
    'workspace:^',
    'npm:pkg@^1.0.0',
    '',
  ])('rejects %s', (spec) => expect(isExactSpec(spec)).toBe(false));
});

describe('findRangeViolations', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const tree = (files: Record<string, unknown>): string => {
    const base = mkdtempSync(join(tmpdir(), 'pins-'));
    dir = base;
    for (const [path, json] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), JSON.stringify(json));
    }
    return base;
  };

  it('finds no ranges in this repository', () => {
    expect(findRangeViolations(root)).toEqual([]);
  });

  it('reports each ranged dependency with its file and field', () => {
    const d = tree({
      'package.json': { devDependencies: { typescript: '5.9.3' } },
      'apps/api/package.json': { dependencies: { fastify: '^5.0.0', zod: '~3.0.0' } },
      'packages/core/package.json': { peerDependencies: { pino: '*' } },
    });
    expect(findRangeViolations(d)).toEqual([
      'apps/api/package.json: dependencies.fastify = ^5.0.0',
      'apps/api/package.json: dependencies.zod = ~3.0.0',
      'packages/core/package.json: peerDependencies.pino = *',
    ]);
  });

  it('ignores installed packages under node_modules', () => {
    const d = tree({
      'package.json': { dependencies: { a: '1.0.0' } },
      'node_modules/a/package.json': { dependencies: { b: '^2.0.0' } },
    });
    expect(findRangeViolations(d)).toEqual([]);
  });
});

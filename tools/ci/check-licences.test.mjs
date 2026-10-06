// @ts-check
/** B002 licence allow-list: GPL fails, MIT passes, SPDX expressions are evaluated. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PNPM_LICENCE_ARGS, findViolations, isAllowedExpression } from './check-licences.mjs';

const script = join(import.meta.dirname, 'check-licences.mjs');
const dir = mkdtempSync(join(tmpdir(), 'licences-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** @param {unknown} report */
function runWith(report) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(report));
  return spawnSync(process.execPath, [script, '--report', file], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('isAllowedExpression', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'ISC',
    '(MIT OR Apache-2.0)',
    'MIT OR GPL-3.0',
    'MIT AND ISC',
    '(MIT AND ISC) OR GPL-3.0',
    'Apache-2.0 WITH LLVM-exception',
  ])('allows %s', (expr) => expect(isAllowedExpression(expr)).toBe(true));

  it.each([
    'GPL-3.0',
    'GPL-3.0-only',
    'AGPL-3.0',
    'LGPL-2.1',
    'MPL-2.0',
    'MIT AND GPL-3.0',
    'UNLICENSED',
    'SEE LICENSE IN LICENSE.md',
    'Unknown',
    '',
    '(MIT',
    'MIT OR',
  ])('rejects %s', (expr) => expect(isAllowedExpression(expr)).toBe(false));
});

describe('findViolations', () => {
  it('lists each disallowed package with its version and licence', () => {
    expect(
      findViolations({
        MIT: [{ name: 'ok-pkg', versions: ['1.0.0'], license: 'MIT' }],
        'GPL-3.0': [{ name: 'copyleft', versions: ['2.1.0'], license: 'GPL-3.0' }],
        Unknown: [{ name: 'mystery', versions: ['0.1.0'] }],
      }),
    ).toEqual(['copyleft@2.1.0 (GPL-3.0)', 'mystery@0.1.0 (Unknown)']);
  });
});

describe('check-licences CLI', () => {
  it('lists licences recursively, so workspace packages are included', () => {
    // Regression: without -r, pnpm reports only the root package and app dependencies slip through.
    expect(PNPM_LICENCE_ARGS).toEqual(['-r', 'licenses', 'list', '--prod', '--json']);
  });

  it('fails on a GPL-3.0 production dependency', () => {
    const r = runWith({
      'GPL-3.0': [{ name: 'copyleft', versions: ['2.1.0'], license: 'GPL-3.0' }],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('copyleft@2.1.0 (GPL-3.0)');
  });

  it('passes an MIT production dependency', () => {
    const r = runWith({ MIT: [{ name: 'ok-pkg', versions: ['1.0.0'], license: 'MIT' }] });
    expect(r.status).toBe(0);
  });

  it('passes when there are no production dependencies', () => {
    expect(runWith({}).status).toBe(0);
  });
});

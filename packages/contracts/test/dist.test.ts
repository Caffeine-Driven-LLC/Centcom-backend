/**
 * The build output is self-contained: a dist/ shipped without src/ still works at runtime
 * (review of B003: a deploy image may copy only dist/).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COPIED, copyValidators } from '../scripts/copy-validators.mjs';

const PACKAGE_DIR = join(import.meta.dirname, '..');
const SRC_DIR = join(PACKAGE_DIR, 'src');
const TIMEOUT = 60_000;
// Inside the package's node_modules: ignored by git, ESLint and Prettier, and Node still resolves
// the validators' runtime dependencies (ajv) from packages/contracts/node_modules.
const CACHE_DIR = join(PACKAGE_DIR, 'node_modules', '.cache');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : [],
  );
}

describe('build output', () => {
  it('hand-written and generated modules import only relative paths inside src/ or packages', () => {
    for (const file of sourceFiles(SRC_DIR)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^;]*?from '([^']+)';/gm)) {
        const spec = m[1] ?? '';
        const where = `${relative(PACKAGE_DIR, file)}: ${spec}`;
        expect(spec.startsWith('#'), where).toBe(false);
        if (spec.startsWith('.')) expect(resolve(file, '..', spec).startsWith(SRC_DIR), where).toBe(true);
      }
    }
  });

  it('copyValidators puts the generated validators next to the compiled code', () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    const dist = mkdtempSync(join(CACHE_DIR, 'copy-'));
    temps.push(dist);
    const written = copyValidators(dist);
    expect(written.map((p) => relative(dist, p).replaceAll('\\', '/'))).toEqual(COPIED.map((f) => `generated/${f}`));
    for (const name of COPIED) {
      expect(readFileSync(join(dist, 'generated', name), 'utf8')).toBe(readFileSync(join(SRC_DIR, 'generated', name), 'utf8'));
    }
  });

  it('a dist/ without src/ imports and validates on its own', { timeout: TIMEOUT }, () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    const root = mkdtempSync(join(CACHE_DIR, 'dist-check-'));
    temps.push(root);
    const dist = join(root, 'dist');
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const compile = spawnSync(
      process.execPath,
      [tsc, '-p', join(PACKAGE_DIR, 'tsconfig.json'), '--outDir', dist, '--composite', 'false', '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false', '--incremental', 'false'],
      { encoding: 'utf8', timeout: TIMEOUT },
    );
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    copyValidators(dist);

    const fixture = join(PACKAGE_DIR, '..', '..', 'contracts', 'fixtures', 'events', 'queue.submit.json');
    const script = `
      import { readFileSync } from 'node:fs';
      const c = await import(${JSON.stringify(pathToFileURL(join(dist, 'index.js')).href)});
      const fx = JSON.parse(readFileSync(${JSON.stringify(fixture)}, 'utf8'));
      console.log(JSON.stringify({
        version: c.CONTRACT_VERSION,
        frame: c.validateEnvelope(fx.frame).ok,
        bad: c.validateEnvelope({ v: 1, t: 'nope' }).ok,
        id: c.isId('ses', c.newId('ses')),
        kinds: c.EVENT_KINDS.length,
      }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: TIMEOUT });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ version: '1.2.0', frame: true, bad: false, id: true, kinds: 45 });
  });
});

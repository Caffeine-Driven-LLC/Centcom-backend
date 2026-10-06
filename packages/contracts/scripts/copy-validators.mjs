// @ts-check
/**
 * Build step (B003): copies the generated plain-JS validators and their declarations from
 * src/generated/ into dist/generated/, so dist/ is self-contained. tsc does not emit them: the
 * TypeScript compiler cannot process functions this long (see README, "Generated code").
 *
 * Usage: node scripts/copy-validators.mjs [--dist <dir>]   (default: the package's dist/)
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Files copied verbatim from src/generated/ to <dist>/generated/. */
export const COPIED = ['validators.js', 'validators.d.ts'];

/**
 * Copies the generated validators into `distDir`/generated.
 * @param {string} distDir
 * @returns {string[]} the written paths
 */
export function copyValidators(distDir) {
  const target = join(distDir, 'generated');
  mkdirSync(target, { recursive: true });
  return COPIED.map((name) => {
    const to = join(target, name);
    copyFileSync(join(PACKAGE_DIR, 'src', 'generated', name), to);
    return to;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--dist');
  copyValidators(resolve(i === -1 ? join(PACKAGE_DIR, 'dist') : (process.argv[i + 1] ?? '')));
}

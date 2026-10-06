// @ts-check
/**
 * Exact-pin check (B001, GUIDELINES §3.9): every dependency in every package.json must be an
 * exact version. Ranges (`^`, `~`, `*`, `>=`, `x`, tags) fail. The only non-version value
 * allowed is `workspace:*` for a dependency on another workspace package.
 * Run by `pnpm lint`; exits 1 and lists each violation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'contracts',
  'plan',
  'site',
]);
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * True when `spec` pins one exact version (or is `workspace:*`).
 * @param {string} spec
 */
export function isExactSpec(spec) {
  if (spec === 'workspace:*') return true;
  const alias = /^npm:(?:@[^/@]+\/)?[^@]+@(.+)$/.exec(spec);
  return EXACT.test(alias?.[1] ?? spec);
}

/**
 * Lists every package.json under `rootDir`, skipping dependencies, build output and shared folders.
 * @param {string} rootDir
 * @returns {string[]}
 */
export function findManifests(rootDir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name === 'package.json') {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

/**
 * Returns one line per non-exact dependency, e.g. `apps/api/package.json: dependencies.fastify = ^5.0.0`.
 * @param {string} rootDir
 * @returns {string[]}
 */
export function findRangeViolations(rootDir) {
  /** @type {string[]} */
  const violations = [];
  for (const file of findManifests(rootDir)) {
    /** @type {Record<string, unknown>} */
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (deps === undefined) continue;
      for (const [name, spec] of Object.entries(/** @type {Record<string, unknown>} */ (deps))) {
        if (typeof spec !== 'string' || !isExactSpec(spec)) {
          const rel = relative(rootDir, file).replaceAll('\\', '/');
          violations.push(`${rel}: ${field}.${name} = ${String(spec)}`);
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const violations = findRangeViolations(root);
  if (violations.length > 0) {
    console.error('Dependencies must be exact versions (no ^, ~, * or ranges):');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
}

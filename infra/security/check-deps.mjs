// @ts-check
/**
 * `pnpm security:deps` (B097): the dependency policy in one command.
 *
 *  1. install scripts: no installed package declares preinstall, install or postinstall (or ships a
 *     binding.gyp) unless it is on infra/security/install-script-allowlist.json with a reason, an
 *     issue link and an expiry (lifecycle scripts are never run here: pnpm-workspace.yaml
 *     ignoreScripts, but a package that needs one is a supply-chain risk to know about);
 *  2. exact pins: no ^, ~ or range in any package.json (tools/repo/check-exact-pins.mjs);
 *  3. licences: every production dependency is MIT, Apache-2.0, BSD, ISC or 0BSD, or on
 *     infra/security/license-allowlist.json (check-licenses.mjs);
 *  4. advisories: `pnpm audit --prod --audit-level high`, retried once. If the advisory service is
 *     unreachable this fails closed on main (--mode closed, the default) and only warns with
 *     --mode warn (pull requests).
 *
 * Usage: node infra/security/check-deps.mjs [--root <dir>] [--mode closed|warn] [--no-audit]
 * Exits 1 listing each violation, 0 when clean.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRangeViolations } from '../../tools/repo/check-exact-pins.mjs';
import { readAllowList } from './allowlist.mjs';
import { checkLicenses } from './check-licenses.mjs';

/** Writes a line to stdout / stderr (the repo's lint forbids `console` outside tools/). */
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);
const writeErr = (/** @type {string} */ text) => process.stderr.write(`${text}\n`);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIFECYCLE = ['preinstall', 'install', 'postinstall'];

/**
 * Packages with an install script, found under `<root>/node_modules/.pnpm`.
 * @param {string} root
 * @returns {{ name: string, version: string, script: string }[]}
 */
export function findInstallScripts(root) {
  const store = join(root, 'node_modules', '.pnpm');
  if (!existsSync(store)) return [];
  /** @type {Map<string, { name: string, version: string, script: string }>} */
  const found = new Map();
  for (const entry of readdirSync(store)) {
    const nested = join(store, entry, 'node_modules');
    if (!existsSync(nested)) continue;
    for (const dir of packageDirs(nested)) {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      /** @type {{ name?: string, version?: string, scripts?: Record<string, string> }} */
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      } catch {
        continue;
      }
      if (pkg.name === undefined || dir.includes(`${join('node_modules', '@centcom')}`)) continue;
      const script =
        LIFECYCLE.find((s) => typeof pkg.scripts?.[s] === 'string') ??
        (existsSync(join(dir, 'binding.gyp')) ? 'binding.gyp' : undefined);
      if (script !== undefined) {
        found.set(`${pkg.name}@${pkg.version ?? '?'}`, {
          name: pkg.name,
          version: pkg.version ?? '?',
          script,
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} nodeModules */
function packageDirs(nodeModules) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(join(nodeModules, entry)))
        out.push(join(nodeModules, entry, sub));
    } else out.push(join(nodeModules, entry));
  }
  return out;
}

/**
 * @typedef {{ failed: boolean, unreachable: boolean, output: string }} AuditResult
 * @typedef {() => AuditResult} AuditRunner
 */

/** `pnpm audit --prod --audit-level high`, as a result instead of an exception. @type {AuditRunner} */
export function runAudit() {
  try {
    const output = execFileSync('pnpm', ['audit', '--prod', '--audit-level', 'high'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { failed: false, unreachable: false, output };
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string }} */ (err);
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    // pnpm exits 1 both for findings and for a failed request; findings name their severity.
    const unreachable =
      !/vulnerabilit|severity|\b(high|critical)\b/i.test(output) &&
      /ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|getaddrinfo|socket|timed out|\b50[234]\b/i.test(
        output,
      );
    return { failed: true, unreachable, output };
  }
}

/**
 * Runs every check and returns the problems (empty: clean) and warnings.
 * @param {{ root: string, mode?: 'closed' | 'warn', audit?: AuditRunner | false, now?: Date, licenseReport?: import('../../tools/ci/check-licences.mjs').LicenceReport }} o
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkDeps(o) {
  const { root } = o;
  const mode = o.mode ?? 'closed';
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  const allowFile = join(root, 'infra', 'security', 'install-script-allowlist.json');
  const allowed = new Set(
    (existsSync(allowFile) ? readAllowList(allowFile, o.now) : []).map((e) => e.package),
  );
  for (const s of findInstallScripts(root)) {
    if (!allowed.has(s.name)) {
      problems.push(
        `install script: ${s.name}@${s.version} declares ${s.script} and is not on install-script-allowlist.json`,
      );
    }
  }

  for (const v of findRangeViolations(root)) problems.push(`not an exact version: ${v}`);

  problems.push(
    ...checkLicenses({
      root,
      ...(o.now ? { now: o.now } : {}),
      ...(o.licenseReport ? { report: o.licenseReport } : {}),
    }),
  );

  if (o.audit !== false) {
    const run = o.audit ?? runAudit;
    let result = run();
    if (result.failed && result.unreachable) result = run(); // one retry for a flaky advisory service
    if (result.failed && !result.unreachable) {
      problems.push(
        `advisory: pnpm audit found high or critical vulnerabilities\n${indent(result.output)}`,
      );
    } else if (result.failed) {
      const message = 'advisory: the audit service could not be reached';
      if (mode === 'closed')
        problems.push(`${message} (failing closed; use --mode warn on pull requests)`);
      else warnings.push(message);
    }
  }
  return { problems, warnings };
}

/** @param {string} text */
const indent = (text) =>
  text
    .trim()
    .split('\n')
    .slice(0, 20)
    .map((l) => `    ${l}`)
    .join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const root = arg('--root') ?? join(HERE, '..', '..');
  const mode = arg('--mode') === 'warn' ? 'warn' : 'closed';
  try {
    const { problems, warnings } = checkDeps({
      root,
      mode,
      audit: process.argv.includes('--no-audit') ? false : undefined,
    });
    for (const w of warnings) writeErr(`warning: ${w}`);
    if (problems.length > 0) {
      writeErr('Dependency policy violations:');
      for (const p of problems) writeErr(`  ${p}`);
      process.exit(1);
    }
    out('Dependency policy passed.');
  } catch (err) {
    writeErr(err instanceof Error ? err.message : 'security:deps failed');
    process.exit(1);
  }
}

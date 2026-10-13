// @ts-check
/**
 * `pnpm security:licenses` (B097): production dependencies are MIT, Apache-2.0, BSD-2/3, ISC or
 * 0BSD (the rule of tools/ci/check-licences.mjs). A package whose licence metadata is missing
 * fails until reviewed. A reviewed exception goes on infra/security/license-allowlist.json with a
 * reason, an issue link and an expiry.
 *
 * Usage: node infra/security/check-licenses.mjs [--root <dir>] [--report <pnpm-licenses.json>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNPM_LICENCE_ARGS, findViolations } from '../../tools/ci/check-licences.mjs';
import { readAllowList } from './allowlist.mjs';

/** Writes a line to stdout / stderr (the repo's lint forbids `console` outside tools/). */
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);
const writeErr = (/** @type {string} */ text) => process.stderr.write(`${text}\n`);

/**
 * Licence problems under `root`, one line each, minus the reviewed exceptions.
 * @param {{ root: string, report?: import('../../tools/ci/check-licences.mjs').LicenceReport, now?: Date }} o
 * @returns {string[]}
 */
export function checkLicenses(o) {
  const allowFile = join(o.root, 'infra', 'security', 'license-allowlist.json');
  const excepted = new Set(
    (existsSync(allowFile) ? readAllowList(allowFile, o.now) : []).map((e) => e.package),
  );
  const report =
    o.report ??
    /** @type {import('../../tools/ci/check-licences.mjs').LicenceReport} */ (
      JSON.parse(
        execFileSync('pnpm', PNPM_LICENCE_ARGS, {
          cwd: o.root,
          encoding: 'utf8',
          timeout: 120_000,
        }) || '{}',
      )
    );
  const out = [];
  for (const line of findViolations(report)) {
    const name = line.slice(0, line.lastIndexOf('@', line.indexOf('(')));
    if (excepted.has(name)) continue;
    const missing = /\((Unknown|UNKNOWN|UNLICENSED|)\)$/.test(line);
    out.push(`licence: ${line}${missing ? ' (no licence metadata; review it)' : ''}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const root = arg('--root') ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const reportPath = arg('--report');
  try {
    const problems = checkLicenses({
      root,
      ...(reportPath ? { report: JSON.parse(readFileSync(reportPath, 'utf8')) } : {}),
    });
    if (problems.length > 0) {
      writeErr('Licence policy violations:');
      for (const p of problems) writeErr(`  ${p}`);
      process.exit(1);
    }
    out('Licence check passed.');
  } catch (err) {
    writeErr(err instanceof Error ? err.message : 'security:licenses failed');
    process.exit(1);
  }
}

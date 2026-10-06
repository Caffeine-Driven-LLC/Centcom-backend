// @ts-check
/**
 * Licence allow-list (B002, GUIDELINES §3.9): every production dependency must be licensed
 * MIT, Apache-2.0, BSD or ISC. SPDX expressions are evaluated: `OR` passes if any branch is
 * allowed, `AND` only if all are, and `WITH <exception>` is judged by its base licence.
 *
 * Usage: node tools/ci/check-licences.mjs [--report <pnpm-licenses.json>]
 * Without --report it runs `pnpm licenses list --prod --json`. Exits 1 listing each violation.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** SPDX ids on the allow-list. "BSD" covers the 0-, 2- and 3-clause variants. */
export const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
]);

/**
 * True when an SPDX licence expression is satisfied by the allow-list.
 * Unknown, empty or non-SPDX values (e.g. `UNLICENSED`, `SEE LICENSE IN ...`) are not allowed.
 * @param {string} expression
 * @returns {boolean}
 */
export function isAllowedExpression(expression) {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let pos = 0;
  /** @returns {boolean | null} */
  const primary = () => {
    const tok = tokens[pos++];
    if (tok === undefined) return null;
    if (tok === '(') {
      const v = orExpr();
      return tokens[pos++] === ')' ? v : null;
    }
    if (tokens[pos] === 'WITH') pos += 2; // an exception only adds permissions to its base licence
    return ALLOWED.has(tok.replace(/\+$/, ''));
  };
  /** @returns {boolean | null} */
  const andExpr = () => {
    let v = primary();
    while (v !== null && tokens[pos] === 'AND') {
      pos++;
      const r = primary();
      v = r === null ? null : v && r;
    }
    return v;
  };
  /** @returns {boolean | null} */
  const orExpr = () => {
    let v = andExpr();
    while (v !== null && tokens[pos] === 'OR') {
      pos++;
      const r = andExpr();
      v = r === null ? null : v || r;
    }
    return v;
  };
  const result = orExpr();
  return result === true && pos === tokens.length;
}

/**
 * @typedef {{ name: string, versions?: string[], license?: string }} LicensedPackage
 * @typedef {Record<string, LicensedPackage[]>} LicenceReport  shape of `pnpm licenses list --json`
 */

/**
 * Returns one line per production package whose licence is not allowed, e.g. `left-pad@1.0.0 (GPL-3.0)`.
 * @param {LicenceReport} report
 * @returns {string[]}
 */
export function findViolations(report) {
  /** @type {string[]} */
  const out = [];
  for (const [group, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      const licence = pkg.license ?? group;
      if (!isAllowedExpression(licence)) {
        out.push(`${pkg.name}@${(pkg.versions ?? []).join(',')} (${licence})`);
      }
    }
  }
  return out.sort();
}

/** @returns {LicenceReport} */
function readReport() {
  const i = process.argv.indexOf('--report');
  const reportPath = i === -1 ? undefined : process.argv[i + 1];
  const json = reportPath
    ? readFileSync(reportPath, 'utf8')
    : execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 120_000,
      });
  return /** @type {LicenceReport} */ (JSON.parse(json || '{}'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findViolations(readReport());
  if (violations.length > 0) {
    console.error(`Production dependencies with a licence outside ${[...ALLOWED].join(', ')}:`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log('Licence check passed: every production dependency is on the allow-list.');
}

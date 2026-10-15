#!/usr/bin/env node
// The release gate deploy.sh runs before a deploy (B092).
//
//   node infra/deploy/release-gate.mjs --env stage|production --git-sha <sha>
//        [--conformance conformance-report.json] [--stage-record <deploy-record.json>]
//        [--require-conformance] [--now <ms>]
//
// Production, always (stage only with --require-conformance, the card's REQUIRE_CONFORMANCE):
//   - conformance-report.json (B100's `pnpm conformance`) exists;
//   - it is for this commit (git_sha);
//   - it is less than 24 h old;
//   - summary.failed is 0 and it ran at least one case.
// Production also needs a stage deploy record (deploy.sh's deploy-record.json from the stage
// server) for the same commit with result "deployed": prod ships only what stage ran.
//
// Prints one JSON line per check and a verdict. Exit codes: 0 pass; 10 gate failed; 2 usage.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_GATE_FAILED = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} path
 * @returns {any}
 */
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * @typedef {{ env: string, gitSha: string, conformance: string, stageRecord?: string | undefined,
 *   requireConformance: boolean, now: number }} GateOptions
 * @typedef {{ check: string, ok: boolean, detail: string | null }} GateCheck
 */

/**
 * The gate's checks for `opts`.
 * @param {GateOptions} opts
 * @returns {GateCheck[]}
 */
export function releaseChecks(opts) {
  /** @type {GateCheck[]} */
  const checks = [];
  /** @type {(check: string, ok: boolean, detail?: string | null) => void} */
  const add = (check, ok, detail = null) => {
    checks.push({ check, ok, detail: ok ? null : detail });
  };
  if (opts.env === 'production' || opts.requireConformance) {
    const report = readJson(opts.conformance);
    if (report === null) {
      add(
        'conformance report present',
        false,
        `${opts.conformance} missing or not JSON: run pnpm conformance`,
      );
    } else {
      add(
        'conformance report is for this commit',
        report.git_sha === opts.gitSha,
        `report is for ${String(report.git_sha)}, deploying ${opts.gitSha}`,
      );
      const age = opts.now - Date.parse(String(report.generated_at));
      add(
        'conformance report is less than 24 h old',
        Number.isFinite(age) && age >= 0 && age < DAY_MS,
        Number.isFinite(age) ? `${Math.round(age / 3_600_000)} h old` : 'no generated_at',
      );
      const s = report.summary ?? {};
      add(
        'conformance report has no failure',
        s.failed === 0 && (s.cases_total ?? 0) > 0,
        `failed: ${String(s.failed)}, cases: ${String(s.cases_total)}`,
      );
    }
  }
  if (opts.env === 'production') {
    const record = opts.stageRecord === undefined ? null : readJson(opts.stageRecord);
    if (record === null) {
      add(
        'stage deployed this commit',
        false,
        opts.stageRecord === undefined
          ? 'pass --stage-record <deploy-record.json from stage>'
          : `${opts.stageRecord} missing or not JSON`,
      );
    } else {
      add(
        'stage deployed this commit',
        record.env === 'stage' && record.result === 'deployed' && record.git_sha === opts.gitSha,
        `stage record: env ${String(record.env)}, result ${String(record.result)}, sha ${String(record.git_sha)}`,
      );
    }
  }
  return checks;
}

/**
 * @param {string[]} argv
 * @returns {GateOptions | null}
 */
function parseArgs(argv) {
  /** @type {Partial<GateOptions> & { conformance: string, requireConformance: boolean, now: number }} */
  const opts = {
    conformance: 'conformance-report.json',
    requireConformance: false,
    now: Date.now(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--env') opts.env = argv[++i];
    else if (a === '--git-sha') opts.gitSha = argv[++i];
    else if (a === '--conformance') opts.conformance = argv[++i] ?? '';
    else if (a === '--stage-record') opts.stageRecord = argv[++i];
    else if (a === '--require-conformance') opts.requireConformance = true;
    else if (a === '--now') opts.now = Number(argv[++i]);
    else return null;
  }
  const { env, gitSha } = opts;
  if (env === undefined || gitSha === undefined) return null;
  if (!['stage', 'production'].includes(env) || !/^[0-9a-f]{7,40}$/.test(gitSha)) return null;
  return { ...opts, env, gitSha };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  const opts = parseArgs(argv);
  if (opts === null) {
    process.stderr.write(
      'usage: release-gate.mjs --env stage|production --git-sha <sha> [--conformance f] [--stage-record f] [--require-conformance]\n',
    );
    return 2;
  }
  const checks = releaseChecks(opts);
  for (const c of checks) process.stdout.write(`${JSON.stringify(c)}\n`);
  const failed = checks.filter((c) => !c.ok).map((c) => c.check);
  process.stdout.write(
    `${JSON.stringify({ gate: failed.length === 0 ? 'pass' : 'fail', env: opts.env, failed })}\n`,
  );
  return failed.length === 0 ? 0 : EXIT_GATE_FAILED;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}

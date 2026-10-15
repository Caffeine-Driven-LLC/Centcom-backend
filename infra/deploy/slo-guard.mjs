#!/usr/bin/env node
/* global fetch, AbortSignal, setTimeout */
// Watches the API right after a deploy (B092): over `--window` seconds (default 300), the share of
// 5xx answers must stay under 1 % and the p95 latency within 2x the baseline, or the deploy is
// rolled back.
//
//   node infra/deploy/slo-guard.mjs --metrics <url> [--host <api host>] [--env stage|production]
//        [--window 300] [--interval 15] [--min-requests 20] [--baseline <json>]
//   node infra/deploy/slo-guard.mjs --metrics <url> [--host <api host>] --snapshot
//
// The numbers are Caddy's (`caddy_http_request_duration_seconds`, per host): every API request
// passes through it, so real traffic is measured, not a probe. `--snapshot` prints the counters
// now (deploy.sh keeps it as the baseline before switching); the guard compares the requests
// answered since it started against it.
// - Too little traffic (under `--min-requests` in the window): nothing to judge, pass.
// - Counters that went backwards (Caddy restarted): the guard starts over from the new values.
// - Metrics that cannot be read: in production that is a breach (fail safe: roll back); in stage
//   a warning, and a pass.
//
// Prints JSON lines. Exit codes: 0 within the SLO (or not enough traffic); 30 breach (deploy.sh
// rolls back); 2 usage.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_SLO_BREACH = 30;
/** The SLO: under 1 % 5xx, p95 within 2x the baseline. */
export const MAX_ERROR_RATE = 0.01;
export const MAX_P95_RATIO = 2;
/** A p95 under this is never a breach (noise on an idle server). */
export const P95_FLOOR_S = 0.05;

const METRIC = 'caddy_http_request_duration_seconds';
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/**
 * @typedef {{ total: number, errors: number, buckets: Record<string, number> }} Snapshot
 * @typedef {{ breach: boolean, reason: string, errorRate?: number, p95?: number | null,
 *   baselineP95?: number | null }} Verdict
 * @typedef {{ metrics: string, host?: string | undefined, env: string, window: number,
 *   interval: number, minRequests: number, baseline: Snapshot | null }} GuardOptions
 */

/**
 * The counters of the Prometheus text `text` for `host` (every host when undefined):
 * {total, errors, buckets: {le: cumulative count}}.
 * @param {string} text
 * @param {string | undefined} host
 * @returns {Snapshot}
 */
export function snapshotOf(text, host) {
  /** @type {Snapshot} */
  const snap = { total: 0, errors: 0, buckets: {} };
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = SAMPLE.exec(line);
    const name = m?.[1] ?? '';
    if (m === null || !name.startsWith(METRIC)) continue;
    /** @type {Record<string, string>} */
    const labels = {};
    for (const l of (m[2] ?? '').matchAll(LABEL)) labels[l[1] ?? ''] = l[2] ?? '';
    if (host !== undefined && labels['host'] !== undefined && labels['host'] !== host) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    if (name === `${METRIC}_count`) {
      snap.total += value;
      if ((labels['code'] ?? '').startsWith('5')) snap.errors += value;
    } else if (name === `${METRIC}_bucket` && labels['le'] !== undefined) {
      const le = labels['le'];
      snap.buckets[le] = (snap.buckets[le] ?? 0) + value;
    }
  }
  return snap;
}

/**
 * `now - before`; null when a counter went backwards (a restart).
 * @param {Snapshot} now
 * @param {Snapshot} before
 * @returns {Snapshot | null}
 */
export function delta(now, before) {
  if (now.total < before.total || now.errors < before.errors) return null;
  /** @type {Record<string, number>} */
  const buckets = {};
  for (const [le, count] of Object.entries(now.buckets)) {
    const d = count - (before.buckets[le] ?? 0);
    if (d < 0) return null;
    buckets[le] = d;
  }
  return { total: now.total - before.total, errors: now.errors - before.errors, buckets };
}

/**
 * The p95 (seconds) of a snapshot's buckets: the smallest bound holding 95 % of the requests.
 * @param {Snapshot} snap
 * @returns {number | null}
 */
export function p95(snap) {
  if (snap.total === 0) return null;
  const bounds = Object.entries(snap.buckets)
    .map(([le, count]) => ({ le: le === '+Inf' ? Infinity : Number(le), count }))
    .sort((a, b) => a.le - b.le);
  for (const { le, count } of bounds) if (count >= 0.95 * snap.total) return le;
  return Infinity;
}

/**
 * The verdict on the requests answered since the guard started.
 * @param {Snapshot} window
 * @param {Snapshot | null} baseline
 * @param {number} minRequests
 * @returns {Verdict}
 */
export function judge(window, baseline, minRequests) {
  if (window.total < minRequests) return { breach: false, reason: 'too_little_traffic' };
  const errorRate = window.errors / window.total;
  if (errorRate >= MAX_ERROR_RATE) return { breach: true, reason: 'error_rate', errorRate };
  const now = p95(window);
  const before = baseline === null ? null : p95(baseline);
  if (now !== null && before !== null && Number.isFinite(before) && now > P95_FLOOR_S) {
    if (now > MAX_P95_RATIO * Math.max(before, P95_FLOOR_S / MAX_P95_RATIO)) {
      return { breach: true, reason: 'latency', p95: now, baselineP95: before, errorRate };
    }
  }
  return { breach: false, reason: 'ok', errorRate, p95: now, baselineP95: before };
}

/**
 * @param {string[]} argv
 * @returns {(GuardOptions & { snapshot: boolean }) | null}
 */
function parseArgs(argv) {
  /** @type {string | undefined} */
  let metrics;
  /** @type {string | undefined} */
  let host;
  let env = 'stage';
  let window = 300;
  let interval = 15;
  let minRequests = 20;
  /** @type {Snapshot | null} */
  let baseline = null;
  let snapshot = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--metrics') metrics = next();
    else if (a === '--host') host = next();
    else if (a === '--env') env = next();
    else if (a === '--window') window = Number(next());
    else if (a === '--interval') interval = Number(next());
    else if (a === '--min-requests') minRequests = Number(next());
    else if (a === '--baseline') baseline = JSON.parse(next() || 'null');
    else if (a === '--snapshot') snapshot = true;
    else return null;
  }
  if (!metrics || !['stage', 'production'].includes(env)) return null;
  if (![window, interval, minRequests].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { metrics, host, env, window, interval, minRequests, baseline, snapshot };
}

/**
 * @param {string} url
 * @param {string | undefined} host
 * @returns {Promise<Snapshot>}
 */
async function read(url, host) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`metrics answered ${res.status}`);
  return snapshotOf(await res.text(), host);
}

/** @param {object} o */
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

/**
 * Runs the guard; resolves the exit code. `sleep` is injectable for tests.
 * @param {GuardOptions} opts
 * @param {(ms: number) => Promise<void>} [sleep]
 * @returns {Promise<number>}
 */
export async function guard(opts, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  /** @param {unknown} err */
  const unreadable = (err) => {
    const detail = err instanceof Error ? err.message : String(err);
    if (opts.env === 'production') {
      say({ slo: 'breach', reason: 'metrics_unreadable', detail });
      return EXIT_SLO_BREACH;
    }
    say({ slo: 'warn', reason: 'metrics_unreadable', detail });
    return 0;
  };
  let start;
  try {
    start = await read(opts.metrics, opts.host);
  } catch (err) {
    return unreadable(err);
  }
  const deadline = Date.now() + opts.window * 1000;
  /** @type {Verdict} */
  let last = { breach: false, reason: 'too_little_traffic' };
  for (;;) {
    const wait = Math.min(opts.interval * 1000, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
    let now;
    try {
      now = await read(opts.metrics, opts.host);
    } catch (err) {
      return unreadable(err);
    }
    const window = delta(now, start);
    if (window === null) {
      say({ slo: 'restart', detail: 'counters went backwards; starting over' });
      start = now;
    } else {
      last = judge(window, opts.baseline, opts.minRequests);
      say({ slo: last.breach ? 'breach' : 'check', requests: window.total, ...last });
      if (last.breach) return EXIT_SLO_BREACH;
    }
    if (Date.now() >= deadline) break;
  }
  say({ slo: 'pass', reason: last.reason });
  return 0;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv);
  } catch {
    opts = null;
  }
  if (opts === null) {
    process.stderr.write(
      'usage: slo-guard.mjs --metrics <url> [--host h] [--env stage|production] [--window s] ' +
        '[--interval s] [--min-requests n] [--baseline json] | --snapshot\n',
    );
    return 2;
  }
  if (opts.snapshot) {
    try {
      say(await read(opts.metrics, opts.host));
      return 0;
    } catch (err) {
      process.stderr.write(`slo-guard: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  return guard(opts);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

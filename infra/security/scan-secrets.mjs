// @ts-check
/**
 * `pnpm security:secrets` (B097): looks for committed credentials in the files git tracks (and the
 * untracked ones it would add), with rules for the credentials this project and its providers
 * issue: AWS access keys, Centcom API keys (`cen_live_` / `cen_test_` + 32 base62), PEM private
 * keys, GitHub, Slack and Stripe tokens. It prints `path:line rule`, never the match.
 *
 * The same rules are in `.gitleaks.toml`, which CI runs over the diff and, weekly, the whole
 * history; this script is the fast local check and the pre-commit hook.
 *
 * Reviewed false positives go in infra/security/secrets-allowlist.json by rule and path prefix,
 * each with a reason and an expiry (a baseline that hides a real finding forever is not allowed).
 *
 * Usage: node infra/security/scan-secrets.mjs [--root <dir>] [--staged]
 * Exit 0 clean, 1 findings, 2 usage or a broken allow-list.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Writes a line to stdout / stderr (the repo's lint forbids `console` outside tools/). */
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);
const writeErr = (/** @type {string} */ text) => process.stderr.write(`${text}\n`);

/** @type {readonly { id: string, regex: RegExp }[]} */
export const RULES = Object.freeze([
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'centcom-api-key', regex: /\bcen_(?:live|test)_[0-9A-Za-z]{32}\b/ },
  { id: 'private-key', regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { id: 'github-token', regex: /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{40,})\b/ },
  { id: 'slack-token', regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'stripe-key', regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  { id: 'stripe-webhook-secret', regex: /\bwhsec_[0-9A-Za-z]{24,}\b/ },
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {{ rule: string, path: string, reason: string, expires: string }} Exception
 */

/**
 * Reads the exceptions; throws on a missing reason or a missing, malformed or past expiry.
 * @param {string} file
 * @param {Date} [now]
 * @returns {Exception[]}
 */
export function readExceptions(file, now = new Date()) {
  if (!existsSync(file)) return [];
  const parsed = /** @type {{ entries?: unknown }} */ (JSON.parse(readFileSync(file, 'utf8')));
  if (!Array.isArray(parsed.entries)) throw new Error(`${file}: needs an "entries" array`);
  return parsed.entries.map((raw, i) => {
    const e = /** @type {Record<string, unknown>} */ (raw ?? {});
    const at = `${file}: entry ${i + 1}`;
    for (const key of ['rule', 'path', 'reason', 'expires']) {
      if (typeof e[key] !== 'string' || e[key] === '')
        throw new Error(`${at}: "${key}" is required`);
    }
    if (!RULES.some((r) => r.id === e['rule']))
      throw new Error(`${at}: unknown rule "${String(e['rule'])}"`);
    const end = new Date(`${String(e['expires'])}T23:59:59.999Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e['expires'])) || Number.isNaN(end.getTime())) {
      throw new Error(`${at}: expires must be a YYYY-MM-DD date`);
    }
    if (end.getTime() < now.getTime()) throw new Error(`${at}: expired on ${String(e['expires'])}`);
    return /** @type {Exception} */ ({
      rule: String(e['rule']),
      path: String(e['path']),
      reason: String(e['reason']),
      expires: String(e['expires']),
    });
  });
}

/**
 * @param {string} root
 * @param {boolean} staged
 * @returns {string[]}
 */
function listFiles(root, staged) {
  const args = staged
    ? ['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const git = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (git.status === 0) {
    return git.stdout
      .toString('utf8')
      .split('\0')
      .filter((f) => f !== '' && existsSync(join(root, f)));
  }
  if (staged) throw new Error('--staged needs a git checkout');
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/**
 * Findings under `root`: `{path, line, rule}`, never the text.
 * @param {{ root: string, staged?: boolean, now?: Date }} o
 * @returns {{ path: string, line: number, rule: string }[]}
 */
export function scanSecrets(o) {
  const exceptions = readExceptions(
    join(o.root, 'infra', 'security', 'secrets-allowlist.json'),
    o.now,
  );
  /** @type {{ path: string, line: number, rule: string }[]} */
  const findings = [];
  for (const path of listFiles(o.root, o.staged === true)) {
    const file = join(o.root, path);
    if (!statSync(file).isFile() || statSync(file).size > MAX_BYTES) continue;
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8192).includes(0)) continue;
    const lines = bytes.toString('latin1').split('\n');
    lines.forEach((text, index) => {
      for (const rule of RULES) {
        if (!rule.regex.test(text)) continue;
        const excepted = exceptions.some(
          (e) =>
            e.rule === rule.id &&
            (path === e.path || path.startsWith(e.path.endsWith('/') ? e.path : `${e.path}/`)),
        );
        if (!excepted) findings.push({ path, line: index + 1, rule: rule.id });
      }
    });
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const root = arg('--root') ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  try {
    const findings = scanSecrets({ root, staged: process.argv.includes('--staged') });
    for (const f of findings) out(`${f.path}:${f.line} ${f.rule}`);
    if (findings.length > 0) {
      writeErr(
        `security:secrets: ${findings.length} finding(s). Remove the secret and rotate it if it was real.`,
      );
      process.exit(1);
    }
    writeErr('security:secrets: clean');
  } catch (err) {
    writeErr(`security:secrets: ${err instanceof Error ? err.message : 'failed'}`);
    process.exit(2);
  }
}

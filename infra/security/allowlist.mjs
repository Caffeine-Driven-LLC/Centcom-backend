// @ts-check
/**
 * Allow-list files of the security scripts (B097): each entry names what is allowed, why, and
 * until when. An entry without a reason, an `issue` link or an expiry (or past it) is an error,
 * so exceptions cannot become permanent by being forgotten.
 */
import { readFileSync } from 'node:fs';

/**
 * @typedef {{ package: string, reason: string, issue: string, expires: string }} AllowEntry
 */

/**
 * Reads `{ "entries": [...] }` and checks every entry. Throws an Error naming the entry.
 * @param {string} path
 * @param {Date} [now]
 * @returns {AllowEntry[]}
 */
export function readAllowList(path, now = new Date()) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path}: cannot be read as JSON`);
  }
  const entries = /** @type {{ entries?: unknown }} */ (parsed).entries;
  if (!Array.isArray(entries)) throw new Error(`${path}: needs an "entries" array`);
  return entries.map((raw, i) => {
    const at = `${path}: entry ${i + 1}`;
    const e = /** @type {Record<string, unknown>} */ (raw ?? {});
    for (const key of ['package', 'reason', 'issue', 'expires']) {
      if (typeof e[key] !== 'string' || e[key] === '')
        throw new Error(`${at}: "${key}" is required`);
    }
    const expires = String(e['expires']);
    const end = new Date(`${expires}T23:59:59.999Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(end.getTime())) {
      throw new Error(`${at}: expires must be a YYYY-MM-DD date`);
    }
    if (end.getTime() < now.getTime()) throw new Error(`${at}: expired on ${expires}`);
    return /** @type {AllowEntry} */ ({
      package: String(e['package']),
      reason: String(e['reason']),
      issue: String(e['issue']),
      expires,
    });
  });
}

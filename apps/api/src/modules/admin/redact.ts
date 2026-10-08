/**
 * What the admin API may show (B087 guardrails).
 *
 * - `maskEmail`: `alice@example.com` becomes `a***@e***.com`, for `support_ro`.
 * - `scrub`: the last pass over every response body. It drops any field whose name says content,
 *   keys or credentials (`ct`, `p`, `key_bundle`, anything with `secret`, `token`, `password` or
 *   `private`, public keys), and rewrites any string that looks like a credential (an API key, a
 *   JWT) or a Stripe id (only a masked tail is kept). Bodies are built from allowlisted fields in
 *   the first place; this catches what a future field or a dependency's answer might add.
 *
 * Owns: the masking and the scrub. Must not: let a value through because its field has an
 * innocent name.
 */
import { parseId } from '@centcom/contracts';

const firstChar = (text: string): string => Array.from(text)[0] ?? '';

/** `a***@d***.com`: the first character of the local part and of the domain, and the TLD. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot <= 0 ? domain : domain.slice(0, dot);
  const tld = dot <= 0 ? '' : domain.slice(dot);
  return `${firstChar(local)}***@${firstChar(host)}***${tld}`;
}

/** Field names never sent, compared in lower case. */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'ct',
  'p',
  'key_bundle',
  'ciphertext',
  'history',
  'snapshot',
  'x25519_pub',
  'ed25519_pub',
  'fingerprint',
  'code_hash',
  'token_hash',
  'key_hash',
]);
/** Field names containing these are never sent either. */
const FORBIDDEN_PARTS = /secret|token|password|private|credential/i;

/** API keys (CT-AUTH) and JWTs. */
const CREDENTIAL = /^(cen_(live|test)_|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.)/;
/** Stripe object ids (`cus_…`, `sub_…`, `pi_…`): only a masked tail may be shown. */
const STRIPE_ID =
  /^(acct|ba|card|ch|cs|cus|evt|ii|il|in|pi|pm|po|price|prod|promo|re|seti|si|src|sub|tr|txn)_[A-Za-z0-9]{8,}$/;

/** `value` as it may be sent: a credential is withheld, a Stripe id keeps its prefix and tail. */
function scrubString(value: string): string {
  if (CREDENTIAL.test(value)) return '[redacted]';
  if (STRIPE_ID.test(value) && parseId(value) === null) {
    const prefix = value.slice(0, value.indexOf('_'));
    return `${prefix}_****${value.slice(-4)}`;
  }
  return value;
}

/** A copy of `value` without forbidden fields or values (see above). */
export function scrub<T>(value: T): T {
  return scrubValue(value) as T;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_NAMES.has(lower) || FORBIDDEN_PARTS.test(lower)) continue;
    out[name] = scrubValue(field);
  }
  return out;
}

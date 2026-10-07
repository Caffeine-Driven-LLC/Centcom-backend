/**
 * Log redaction (B005): `redact(value)` returns a deep copy of a value that is safe to log. Values
 * under deny-listed keys are replaced, secrets inside strings (API keys, JWTs, Bearer credentials)
 * are replaced wherever they appear, long strings are cut, and deep, cyclic or exotic structures
 * become placeholders. The logger runs every line through it, so call sites cannot skip it.
 *
 * Owns: the key deny list, the secret value patterns and the size limits. Must not: mutate its
 * input, throw, or let through any part of a value that one of its rules covers.
 */
import { REDACTED, Secret } from '../config/secret.js';

/** Replaces a cyclic reference, or an object whose properties cannot be read (a throwing getter, a revoked Proxy). */
export const UNSERIALISABLE = '[unserialisable]';
/** Replaces objects nested deeper than MAX_LOG_DEPTH, and containers past the MAX_LOG_ENTRIES budget. */
export const TRUNCATED = '[truncated]';
/** Longest string kept, in UTF-16 code units, including the `…` that marks a cut. Keys too. */
export const MAX_LOG_STRING_LENGTH = 2000;
/** The logged value and this many levels of objects below it are copied; deeper ones are TRUNCATED. */
export const MAX_LOG_DEPTH = 8;
/** At most this many object properties and array items are copied per call. */
export const MAX_LOG_ENTRIES = 100_000;

const ELLIPSIS = '…';

/** Key comparison ignores case, `-` and `_`: `Authorization`, `refreshToken` and `API-KEY` match. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

/**
 * Keys whose values are never logged (GUIDELINES §3.5, CT-CRYPTO §3): credentials, frame content
 * and work content. The card's list, plus relay and LAN tickets (CT-AUTH, CT-LAN) and the
 * WebSocket header the relay must not log (B037).
 */
const DENY_KEYS: ReadonlySet<string> = new Set(
  [
    'authorization',
    'cookie',
    'set-cookie',
    'token',
    'refresh_token',
    'access_token',
    'secret',
    'password',
    'api_key',
    'ct',
    'sig',
    'text',
    'p',
    'body',
    'path',
    'branch',
    'cwd',
    'device_code',
    'user_code',
    'code_verifier',
    'code',
    'ticket',
    'sec-websocket-protocol',
  ].map(normalizeKey),
);

/**
 * Compound keys ending in one of these are denied too: `id_token`, `x-api-key`,
 * `proxy-authorization`, `authorization_code`, `file_path`. Short or generic words (`p`, `ct`,
 * `code`, `text`, `body`) match exactly only, so `status_code` and `context` stay readable.
 */
const DENY_SUFFIXES = [
  'token',
  'apikey',
  'privatekey',
  'authorization',
  'authcode',
  'authorizationcode',
  'devicecode',
  'usercode',
  'codeverifier',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'signature',
  'ticket',
  'path',
  'paths',
  'branch',
  'branches',
];

/** Keys containing one of these anywhere are denied: `client_secret`, `secret_key`, `password_hash`. */
const DENY_PARTS = ['secret', 'password', 'passwd'];

function isDeniedKey(key: string): boolean {
  const k = normalizeKey(key);
  return (
    DENY_KEYS.has(k) ||
    DENY_SUFFIXES.some((suffix) => k.endsWith(suffix)) ||
    DENY_PARTS.some((part) => k.includes(part))
  );
}

/** CT-AUTH API keys: `cen_live_` or `cen_test_` plus base62, at any length so a mangled key is caught. */
const API_KEY = /cen_(?:live|test)_[0-9A-Za-z]+/g;
/**
 * Maximal runs of base64url characters and dots (JWTs are unpadded, RFC 7515). Every match ends
 * where its run ends, so the scan is linear even on hostile input such as `eyJeyJeyJ…`.
 */
const DOTTED_RUN = /[A-Za-z0-9_.-]+/g;
/**
 * A run holding a JWS or JWE compact serialisation: `eyJ` (the start of a JSON header) followed
 * by at least two dots. The whole run is replaced, so text glued to the token goes with it.
 */
function isJwtRun(run: string): boolean {
  const start = run.indexOf('eyJ');
  if (start < 0) return false;
  const dot = run.indexOf('.', start);
  return dot >= 0 && run.includes('.', dot + 1);
}
/** `Bearer <credential>` (RFC 6750 b64token) in any case; the scheme word is kept for context. */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;
const BEARER_HINT = /bearer/i;

/** Replaces every secret the value patterns find in `s`. */
function replaceSecrets(s: string): string {
  let out = s;
  if (out.includes('eyJ')) out = out.replace(DOTTED_RUN, (run) => (isJwtRun(run) ? REDACTED : run));
  if (out.includes('cen_')) out = out.replace(API_KEY, REDACTED);
  if (BEARER_HINT.test(out)) out = out.replace(BEARER, `$1 ${REDACTED}`);
  return out;
}

/** True for characters that can appear inside a credential (base64, base64url, b64token, JWT dots). */
function isCredentialChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 43 || // +
    c === 45 || // -
    c === 46 || // .
    c === 47 || // /
    c === 61 || // =
    c === 95 || // _
    c === 126 // ~
  );
}

/**
 * Where to cut `s` so it keeps at most `limit` code units. A run of credential characters that
 * crosses the cut is dropped whole, so the cut can never leave the start of a secret behind for the
 * patterns to miss; a surrogate pair is never split.
 */
function cutIndex(s: string, limit: number): number {
  let i = limit;
  if (isCredentialChar(s.charCodeAt(i))) {
    while (i > 0 && isCredentialChar(s.charCodeAt(i - 1))) i -= 1;
  }
  const before = s.charCodeAt(i - 1);
  if (before >= 0xd800 && before <= 0xdbff) i -= 1;
  return i;
}

/** A string that is safe to log: secrets replaced, at most MAX_LOG_STRING_LENGTH code units. */
export function redactText(s: string): string {
  let cut = s.length > MAX_LOG_STRING_LENGTH;
  let out = cut ? s.slice(0, cutIndex(s, MAX_LOG_STRING_LENGTH - 1)) : s;
  out = replaceSecrets(out);
  // `[redacted]` can be longer than what it replaced; cutting after the patterns ran leaks nothing.
  const room = MAX_LOG_STRING_LENGTH - (cut ? ELLIPSIS.length : 0);
  if (out.length > room) {
    out = out.slice(0, cutIndex(out, MAX_LOG_STRING_LENGTH - ELLIPSIS.length));
    cut = true;
  }
  return cut ? out + ELLIPSIS : out;
}

interface KeyInfo {
  /** The key is on the deny list. */
  readonly denied: boolean;
  /** The key as logged: keys get the same treatment as string values. */
  readonly text: string;
}

interface WalkState {
  /** Remaining MAX_LOG_ENTRIES budget. */
  entries: number;
  /** Objects on the current path: meeting one again is a cycle (shared references are fine). */
  readonly ancestors: Set<object>;
  /** Per-call cache: keys repeat across the items of an array. At most MAX_LOG_ENTRIES entries. */
  readonly keys: Map<string, KeyInfo>;
}

function keyInfo(key: string, state: WalkState): KeyInfo {
  let info = state.keys.get(key);
  if (info === undefined) {
    info = { denied: isDeniedKey(key), text: redactText(key) };
    state.keys.set(key, info);
  }
  return info;
}

function walk(value: unknown, depth: number, state: WalkState): unknown {
  switch (typeof value) {
    case 'string':
      return redactText(value);
    case 'number':
    case 'boolean':
    case 'undefined':
      return value;
    case 'bigint':
      return value.toString();
    case 'symbol':
    case 'function':
      return undefined; // as JSON.stringify does
    default:
      return value === null ? null : walkObject(value as object, depth, state);
  }
}

function walkObject(value: object, depth: number, state: WalkState): unknown {
  if (state.ancestors.has(value)) return UNSERIALISABLE;
  if (depth > MAX_LOG_DEPTH || state.entries <= 0) return TRUNCATED;
  state.ancestors.add(value);
  try {
    return copyObject(value, depth, state);
  } catch {
    // A getter, toJSON or Proxy trap threw: the whole subtree is replaced.
    return UNSERIALISABLE;
  } finally {
    state.ancestors.delete(value);
  }
}

/** Only web URLs are kept, without credentials, query or fragment; `file:` and others would show paths. */
const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function copyObject(value: object, depth: number, state: WalkState): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (--state.entries < 0) return TRUNCATED;
      out.push(walk(value[i], depth + 1, state));
    }
    return out;
  }
  // Plain objects, by far the most common case, need none of the class checks below.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    if (value instanceof Secret) return REDACTED;
    // Binary data is likely key material or ciphertext.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
    if (value instanceof SharedArrayBuffer) return REDACTED;
    if (value instanceof Error) return copyError(value, depth, state);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof URL) {
      return WEB_PROTOCOLS.has(value.protocol)
        ? redactText(value.origin + value.pathname)
        : REDACTED;
    }
    // Boxed primitives: copied as their value, so a boxed secret string still meets the patterns.
    if (value instanceof String) return redactText(value.valueOf());
    if (value instanceof Number || value instanceof Boolean) return value.valueOf();
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const json: unknown = toJSON.call(value);
    // One level deeper, so a chain of toJSON results ends at the depth cap.
    if (json !== value) return walk(json, depth + 1, state);
  }
  return copyEntries(value, Object.keys(value), depth, state, false);
}

/**
 * Copies own enumerable string-keyed properties, applying the key deny list. On an Error, `code`
 * is the error's code (`ECONNREFUSED`, a CT-ERR code), not an OAuth code, so it is kept.
 */
function copyEntries(
  value: object,
  keys: readonly string[],
  depth: number,
  state: WalkState,
  isError: boolean,
  out: Record<string, unknown> = {},
): Record<string, unknown> | typeof TRUNCATED {
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (--state.entries < 0) return TRUNCATED;
    const item = record[key];
    const { denied, text: safeKey } = keyInfo(key, state);
    let copy: unknown;
    if (isError && key === 'code' && (typeof item === 'string' || typeof item === 'number')) {
      copy = walk(item, depth + 1, state);
    } else if (denied) {
      copy = item === undefined ? undefined : REDACTED;
    } else {
      copy = walk(item, depth + 1, state);
    }
    if (safeKey === '__proto__') {
      Object.defineProperty(out, safeKey, {
        value: copy,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[safeKey] = copy;
    }
  }
  return out;
}

/** Errors keep their non-enumerable name, message, stack, cause and AggregateError errors. */
function copyError(error: Error, depth: number, state: WalkState): unknown {
  const out: Record<string, unknown> = {
    type: redactText(String(error.name)),
    message: redactText(String(error.message)),
  };
  if (typeof error.stack === 'string') out['stack'] = redactText(error.stack);
  const copied = copyEntries(error, Object.keys(error), depth, state, true, out);
  if (copied === TRUNCATED) return TRUNCATED;
  if (error.cause !== undefined) out['cause'] = walk(error.cause, depth + 1, state);
  if (error instanceof AggregateError) out['errors'] = walk(error.errors, depth + 1, state);
  return out;
}

/**
 * Returns a deep copy of `value` that is safe to log; never mutates `value` and never throws.
 *
 * - Values under deny-listed keys (`authorization`, `cookie`, `token`, `password`, `ct`, `p`,
 *   `body`, `path`, `branch`, `code`, ... compared ignoring case, `-` and `_`, plus compound
 *   names such as `id_token` or `client_secret`) become `[redacted]`.
 * - Inside every string and key, CT-AUTH API keys (`cen_live_…`), JWTs and `Bearer` credentials
 *   become `[redacted]`.
 * - Strings longer than MAX_LOG_STRING_LENGTH are cut and end in `…`.
 * - Cycles and unreadable objects become `[unserialisable]`; objects deeper than MAX_LOG_DEPTH,
 *   and everything past MAX_LOG_ENTRIES, become `[truncated]`.
 * - `Secret`s and binary data become `[redacted]`; errors keep type, message, stack and cause;
 *   dates become ISO strings; URLs keep only origin and path; bigints become strings.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, { entries: MAX_LOG_ENTRIES, ancestors: new Set(), keys: new Map() });
}

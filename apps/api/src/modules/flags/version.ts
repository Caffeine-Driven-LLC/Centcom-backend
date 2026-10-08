/**
 * Client versions (B083, CT-VER): the version a Centcom client announces in its `User-Agent`,
 * `centcom-cli/1.4.2 (contract/1.0.0; linux-x64; node/22.9.0)`, as a semantic version, and the
 * SemVer 2.0 order between two of them. Anything that is not such a header (another product, a
 * malformed or overlong one) is an unknown version: callers get only flags without version rules.
 *
 * Owns: parsing and comparing versions. Must not: throw on any header.
 */

/** A parsed semantic version. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers (`rc.1` is `['rc', '1']`); empty for a release. */
  pre: readonly string[];
}

/** Headers longer than this are not read. */
export const MAX_USER_AGENT_LENGTH = 512;

const NUMBER = '(0|[1-9]\\d{0,8})';
const IDENT = '[0-9A-Za-z-]+';
const SEMVER = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`,
);
/** `centcom-<product>/<version>` at the start of the header, then a space or the end. */
const PRODUCT = /^centcom-[a-z][a-z0-9-]{0,31}\/(\S+)(?:\s|$)/;

/** `text` as a semantic version, or null. */
export function parseSemver(text: string): Semver | null {
  const m = SEMVER.exec(text);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/** The version a Centcom client's `User-Agent` announces, or null when it is unknown. */
export function parseClientVersion(userAgent: unknown): Semver | null {
  if (typeof userAgent !== 'string' || userAgent.length > MAX_USER_AGENT_LENGTH) return null;
  const m = PRODUCT.exec(userAgent);
  return m?.[1] === undefined ? null : parseSemver(m[1]);
}

const NUMERIC = /^\d+$/;

/** -1, 0 or 1: `a` before, equal to or after `b` in SemVer 2.0 precedence. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = NUMERIC.test(x);
    const yn = NUMERIC.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * ETags of the account (B022, CT-PAGE conditional requests): a strong ETag naming the version of
 * the user row, the microseconds of its `updated_at`, which every profile change moves. `If-Match`
 * is parsed into the versions it accepts, so the update can compare and set in SQL.
 *
 * Owns: the ETag format. Must not: be compared weakly (RFC 9110: If-Match uses strong comparison).
 */

/** The version of a user row: microseconds since the epoch of `updated_at`, as decimal digits. */
export type UserVersion = string;

const VERSION = /^\d{1,20}$/;
const ETAG = /^"v(\d{1,20})"$/;

/** The ETag of a user version: `"v<version>"`. */
export function computeEtag(user: { version: UserVersion }): string {
  if (!VERSION.test(user.version))
    throw new TypeError('computeEtag: the version must be decimal digits');
  return `"v${user.version}"`;
}

/** What an If-Match header accepts: any current version (`*`), or one of the listed versions. */
export type IfMatch = { any: true } | { any: false; versions: UserVersion[] };

/**
 * Parses an If-Match header. `*` accepts any version; otherwise the strong ETags listed (comma
 * separated) are kept and weak (`W/`) or foreign ones dropped, so they never match. Undefined when
 * the header is absent.
 */
export function parseIfMatch(header: string | string[] | undefined): IfMatch | undefined {
  if (header === undefined) return undefined;
  const values = (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(','));
  const versions: UserVersion[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '*') return { any: true };
    const match = ETAG.exec(value);
    if (match?.[1] !== undefined) versions.push(match[1]);
  }
  return { any: false, versions };
}

/** True when `ifMatch` (if any) accepts `version`. */
export function ifMatchAccepts(ifMatch: IfMatch | undefined, version: UserVersion): boolean {
  return ifMatch === undefined || ifMatch.any || ifMatch.versions.includes(version);
}

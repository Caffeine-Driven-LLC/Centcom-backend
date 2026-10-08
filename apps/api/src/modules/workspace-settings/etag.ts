/**
 * ETags of workspace settings (B034): `"s<version>"`, the settings row's version (`"s0"` while the
 * workspace has the defaults). The `s` keeps them apart from the workspace's own `"v<version>"`
 * ETags, so a workspace's ETag sent to `/settings` never matches. `If-Match` is parsed into the
 * versions it accepts, compared strongly (RFC 9110).
 *
 * Owns: the ETag format.
 */
import type { IfMatch } from '../me/etag.js';

const ETAG = /^"s(\d{1,10})"$/;

/** The ETag of settings `version`. */
export function settingsEtag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('settingsEtag: the version must be a non-negative integer');
  }
  return `"s${version}"`;
}

/**
 * Parses an If-Match header against settings ETags: `*` accepts any version; otherwise the
 * settings ETags listed are kept, and weak or foreign ones dropped, so they never match.
 * Undefined when the header is absent.
 */
export function parseSettingsIfMatch(header: string | string[] | undefined): IfMatch | undefined {
  if (header === undefined) return undefined;
  const values = (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(','));
  const versions: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '*') return { any: true };
    const match = ETAG.exec(value);
    if (match?.[1] !== undefined) versions.push(match[1]);
  }
  return { any: false, versions };
}

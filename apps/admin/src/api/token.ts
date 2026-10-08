/**
 * The staff access token (B088): kept in memory only, never in storage, cookies, URLs or logs.
 *
 * The console reads one claim, `sub`, to know whose staff record to ask the API for; the role comes
 * from that answer, never from the token. Nothing here verifies the token: the admin API does, on
 * every call.
 */

const USER_ID = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The `usr_` id in a JWT's `sub` claim; null for anything that is not such a token. */
export function subjectOf(token: string): string | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof claims.sub === 'string' && USER_ID.test(claims.sub) ? claims.sub : null;
  } catch {
    return null;
  }
}

/** True for a `prefix_` CT-IDS id (`usr`, `wsp`, `ses`, ...). */
export function isId(prefix: string, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}

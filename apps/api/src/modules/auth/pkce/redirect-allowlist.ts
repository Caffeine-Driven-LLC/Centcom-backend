/**
 * Redirect URI allow-list (B018, CT-AUTH "Redirect URIs"): which `redirect_uri` values each public
 * client may use on `GET /v1/auth/authorize` and the `authorization_code` grant.
 *
 * Matching is by exact string: one character more or less, a trailing slash, another case or an
 * added query is a different URI. The one exception is RFC 8252 §7.3: an entry for a loopback IP
 * literal without a port (`http://127.0.0.1/callback`, `http://[::1]/callback`) also matches that
 * URI with any port, because native clients listen on a port they pick at run time.
 *
 * Owns: checking the configured entries and the match. Must not: match by prefix, host or pattern,
 * or accept an entry with credentials, a query or a fragment.
 */
import type { ClientId } from '@centcom/db';
import { CLIENT_IDS } from '../tokens/service.js';

/** The longest `redirect_uri` considered, in characters. */
export const MAX_REDIRECT_URI_LENGTH = 2048;
/** The most entries one client may register. */
export const MAX_REDIRECT_URIS_PER_CLIENT = 16;
/** The desktop custom scheme (CT-AUTH). */
export const DESKTOP_REDIRECT_URI = 'centcom://auth/callback';

/** Hosts of the loopback IP literals whose port may vary (RFC 8252 §7.3). */
const LOOPBACK_IPS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);
/** `http://<loopback IP>:<port><path>`, split into host, port and the rest. */
const LOOPBACK_WITH_PORT = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/.*)$/s;

/** CT-AUTH's registered URIs: web callback; loopback and desktop scheme for the terminal clients. */
export const DEFAULT_REDIRECT_URIS: Readonly<Record<ClientId, readonly string[]>> = {
  'centcom-web': ['https://app.centcom.dev/auth/callback'],
  'centcom-cli': ['http://127.0.0.1/callback', 'http://[::1]/callback', DESKTOP_REDIRECT_URI],
  'centcom-tui': ['http://127.0.0.1/callback', 'http://[::1]/callback', DESKTOP_REDIRECT_URI],
};

/** Decides whether a client may be sent to a URI. */
export interface RedirectAllowlist {
  /** True when `redirectUri` is registered for `clientId` (exact match, loopback ports aside). */
  allows(clientId: string, redirectUri: unknown): boolean;
}

/**
 * Why `entry` cannot be registered, or undefined when it can: an absolute URI in the URL parser's
 * canonical form, without credentials, query or fragment, using `https`, `http` on a loopback host
 * (127.0.0.1, [::1] or localhost) or the `centcom:` scheme.
 */
export function redirectEntryProblem(entry: unknown): string | undefined {
  if (typeof entry !== 'string' || entry === '' || entry.length > MAX_REDIRECT_URI_LENGTH) {
    return `must be a non-empty string of at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return 'must be an absolute URI';
  }
  if (url.href !== entry) return 'must be written the way the URL parser prints it';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  if (url.search !== '' || url.hash !== '') return 'must not contain a query or a fragment';
  if (url.protocol === 'https:' || url.protocol === 'centcom:') return undefined;
  if (url.protocol === 'http:') {
    return LOOPBACK_IPS.has(url.hostname) || url.hostname === 'localhost'
      ? undefined
      : 'may use http only on a loopback host (127.0.0.1, [::1] or localhost)';
  }
  return 'must use https, http (loopback only) or the centcom: scheme';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a JSON map `{client_id: [uri, ...]}`: known clients only, 1 to 16 unique entries each,
 * every entry valid (see `redirectEntryProblem`). A client left out may not use the PKCE flow.
 */
export function readRedirectUris(
  json: string,
): { ok: true; value: Partial<Record<ClientId, string[]>> } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, problem: 'is not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, problem: 'must be a JSON object of client ids' };
  const value: Partial<Record<ClientId, string[]>> = {};
  for (const [clientId, entries] of Object.entries(parsed)) {
    if (!(CLIENT_IDS as readonly string[]).includes(clientId)) {
      return { ok: false, problem: `names an unknown client (${CLIENT_IDS.join(', ')} only)` };
    }
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.length > MAX_REDIRECT_URIS_PER_CLIENT ||
      new Set(entries).size !== entries.length
    ) {
      return {
        ok: false,
        problem: `must give each client 1 to ${MAX_REDIRECT_URIS_PER_CLIENT} distinct URIs`,
      };
    }
    for (const [i, entry] of entries.entries()) {
      const problem = redirectEntryProblem(entry);
      if (problem !== undefined) {
        return { ok: false, problem: `${clientId} entry ${i + 1} ${problem}` };
      }
    }
    value[clientId as ClientId] = entries as string[];
  }
  return { ok: true, value };
}

/** An allow-list over checked entries (see `readRedirectUris`). */
export function redirectAllowlist(
  uris: Readonly<Partial<Record<ClientId, readonly string[]>>>,
): RedirectAllowlist {
  const exact = new Map<string, ReadonlySet<string>>();
  const anyPort = new Map<string, ReadonlySet<string>>();
  for (const clientId of CLIENT_IDS) {
    const entries = uris[clientId] ?? [];
    exact.set(clientId, new Set(entries));
    anyPort.set(
      clientId,
      new Set(
        entries.filter((entry) => {
          const url = new URL(entry);
          return url.protocol === 'http:' && LOOPBACK_IPS.has(url.hostname) && url.port === '';
        }),
      ),
    );
  }
  return {
    allows(clientId, redirectUri) {
      if (typeof redirectUri !== 'string' || redirectUri.length > MAX_REDIRECT_URI_LENGTH) {
        return false;
      }
      if (exact.get(clientId)?.has(redirectUri) === true) return true;
      const match = LOOPBACK_WITH_PORT.exec(redirectUri);
      if (match === null || Number(match[2]) > 65535) return false;
      return anyPort.get(clientId)?.has(`http://${match[1]}${match[3]}`) === true;
    },
  };
}

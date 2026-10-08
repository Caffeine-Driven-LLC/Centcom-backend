/**
 * Building Centcom's links (B033, CT-DEEPLINK): the web and app URL of each row of the contract's
 * table. Web URLs live on one origin (WEB_BASE_URL, `https://centcom.dev` by default); app URLs use
 * the `centcom://` scheme.
 *
 *   join a session    https://centcom.dev/j/<token>    centcom://join/<token>
 *   open a session    https://centcom.dev/s/<ses_id>   centcom://session/<ses_id>[?focus=approval|queue]
 *   auth callback     (none)                           centcom://auth/callback?code=…&state=…
 *   billing           https://centcom.dev/billing      centcom://billing
 *   workspace invite  https://centcom.dev/i/<token>    centcom://invite/<token>
 *   viewer guest      https://centcom.dev/g/<token>    centcom://share/<token>
 *
 * Every builder checks what it is given and throws a TypeError for anything else (a token with
 * `#` in it, say): a URL the server builds never carries a fragment, and never an
 * open-redirect parameter.
 *
 * Owns: the table and the builders. Must not: add `#k=` or any other fragment (key material
 * stays with clients, CT-CRYPTO §4), or a parameter the table does not name.
 */
import { isId } from '@centcom/contracts';
import { assertServerUrl } from './fragment.js';

/** The web origin when WEB_BASE_URL is not set. */
export const DEFAULT_WEB_BASE_URL = 'https://centcom.dev';
/** The app links' scheme, with its `//`. */
export const APP_SCHEME = 'centcom://';

/** A link token: 160 bits as 27 base64url characters. */
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{27}$/;
/** What a builder accepts as a token. */
const BUILD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An authorization code or `state` in an auth callback: RFC 3986 unreserved characters. */
export const AUTH_PARAM_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

/** Where a session link opens the session. */
export const SESSION_FOCUSES = ['approval', 'queue'] as const;
/** A session focus. */
export type SessionFocus = (typeof SESSION_FOCUSES)[number];

/** The web and app form of one link. */
export interface LinkPair {
  web: string;
  app: string;
}

/** True for a string shaped like a link token. */
export const isLinkToken = (value: unknown): value is string =>
  typeof value === 'string' && LINK_TOKEN_PATTERN.test(value);

/** True for `approval` or `queue`. */
export const isSessionFocus = (value: unknown): value is SessionFocus =>
  typeof value === 'string' && (SESSION_FOCUSES as readonly string[]).includes(value);

/**
 * The origin of a web base URL (`https://host[:port]`, lower case), or null unless it is an https
 * URL with nothing but an origin: no credentials, path, query or fragment (a trailing `/` is fine).
 */
export function webOrigin(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const plain =
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !base.includes('#') &&
    !base.includes('?');
  return plain ? url.origin : null;
}

/** The origin of `base`; throws a TypeError for anything webOrigin refuses. */
function originOf(base: string): string {
  const origin = webOrigin(base);
  if (origin === null) throw new TypeError('the web base URL must be a plain https origin');
  return origin;
}

/**
 * Builders take any short base64url token (tokens the server makes are 27 characters; the parser
 * is the strict side) and refuse anything else, `#` included.
 */
function checkToken(token: string): void {
  if (typeof token !== 'string' || !BUILD_TOKEN_PATTERN.test(token)) {
    throw new TypeError('a link token is 1 to 64 base64url characters');
  }
}

function pair(web: string, app: string): LinkPair {
  return { web: assertServerUrl(web), app: assertServerUrl(app) };
}

/** Join a session: `<base>/j/<token>` and `centcom://join/<token>`. */
export function buildJoinUrl(token: string, base: string = DEFAULT_WEB_BASE_URL): LinkPair {
  checkToken(token);
  return pair(`${originOf(base)}/j/${token}`, `${APP_SCHEME}join/${token}`);
}

/** Accept a workspace invite: `<base>/i/<token>` and `centcom://invite/<token>`. */
export function buildInviteUrl(token: string, base: string = DEFAULT_WEB_BASE_URL): LinkPair {
  checkToken(token);
  return pair(`${originOf(base)}/i/${token}`, `${APP_SCHEME}invite/${token}`);
}

/** Join as a viewer guest (a share link): `<base>/g/<token>` and `centcom://share/<token>`. */
export function buildShareUrl(token: string, base: string = DEFAULT_WEB_BASE_URL): LinkPair {
  checkToken(token);
  return pair(`${originOf(base)}/g/${token}`, `${APP_SCHEME}share/${token}`);
}

/**
 * Open a session: `<base>/s/<ses_id>` and `centcom://session/<ses_id>`, the app form with
 * `?focus=approval|queue` when a focus is given (the table gives the web form none).
 */
export function buildSessionUrl(
  sessionId: string,
  focus?: SessionFocus,
  base: string = DEFAULT_WEB_BASE_URL,
): LinkPair {
  if (!isId('ses', sessionId)) throw new TypeError('a session link needs a ses_ id');
  if (focus !== undefined && !isSessionFocus(focus)) {
    throw new TypeError('a session focus is approval or queue');
  }
  const query = focus === undefined ? '' : `?focus=${focus}`;
  return pair(`${originOf(base)}/s/${sessionId}`, `${APP_SCHEME}session/${sessionId}${query}`);
}

/** Upgrade or billing: `<base>/billing` and `centcom://billing`. */
export function buildBillingUrl(base: string = DEFAULT_WEB_BASE_URL): LinkPair {
  return pair(`${originOf(base)}/billing`, `${APP_SCHEME}billing`);
}

/** The desktop PKCE callback (app only): `centcom://auth/callback?code=…&state=…`. */
export function buildAuthCallbackUrl(code: string, state: string): string {
  if (!AUTH_PARAM_PATTERN.test(code) || !AUTH_PARAM_PATTERN.test(state)) {
    throw new TypeError('code and state are 1 to 512 unreserved URL characters');
  }
  return assertServerUrl(`${APP_SCHEME}auth/callback?code=${code}&state=${state}`);
}

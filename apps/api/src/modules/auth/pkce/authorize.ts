/**
 * Browser authorize (B018, CT-AUTH, RFC 6749 §4.1.1 with RFC 7636): checks an authorize request
 * and decides where the browser goes next. A signed-in browser gets a one-time code on its
 * registered `redirect_uri` with `state` echoed unchanged; any other browser goes to the web login
 * page with a signed `return_to` that brings it back to this very request after login.
 *
 * Errors are answered directly (400 `invalid_request` or `invalid_scope`, 401 `invalid_client`),
 * never by redirecting: not even to a registered URI. `return_to` is a short JWT signed with the
 * token keys (B017) under its own `typ` and audience, so it cannot pass as an access token; the
 * login lanes open it with `openReturnTo` and get null for anything tampered with or expired.
 *
 * Owns: the request checks, code issue and the return_to seal. Must not: redirect before the
 * client and redirect URI are checked, accept `plain`, or put a token in a URL (the code aside).
 */
import { AppError } from '@centcom/core';
import type { ClientId } from '@centcom/db';
import type { TokenKeys } from '../tokens/config.js';
import { signJwt, verifyJwt } from '../tokens/jwt.js';
import { CLIENT_IDS, SCOPES } from '../tokens/service.js';
import type { AuthorizationCodeStore } from './code-store.js';
import { isS256Challenge } from './pkce.js';
import type { RedirectAllowlist } from './redirect-allowlist.js';

/** The endpoint. */
export const AUTHORIZE_PATH = '/v1/auth/authorize';
/** CT-AUTH: the default scope of every public client is the CLI default scope. */
export const DEFAULT_SCOPE =
  'profile workspaces:read sessions:read sessions:write sessions:host usage:write billing:read';
/** The longest `state` accepted, in characters. */
export const MAX_STATE_LENGTH = 1024;
/** How long a login may take before its `return_to` expires (covers a 60-minute e-mail link). */
export const RETURN_TO_TTL_S = 3600;
/** `typ` and audience of a `return_to`. */
export const RETURN_TO_TYPE = 'centcom-return-to+jwt';
export const RETURN_TO_AUDIENCE = 'centcom-login';
/** The longest authorize URL that is sealed into a `return_to`. */
export const MAX_RETURN_TO_PATH_LENGTH = 8192;

/** Scopes the public flows may grant (`admin` is internal: CT-RBAC). */
const PUBLIC_SCOPES: ReadonlySet<string> = new Set(SCOPES.filter((scope) => scope !== 'admin'));

/** A checked authorize request. */
export interface AuthorizeRequest {
  clientId: ClientId;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** Space-separated. */
  scope: string;
}

/** Dependencies of the authorizer. */
export interface AuthorizerDeps {
  codes: AuthorizationCodeStore;
  redirects: RedirectAllowlist;
  /** `WEB_LOGIN_URL`: absolute, without a query or fragment. */
  loginUrl: string;
  /** B017's keys, to sign `return_to`. */
  keys: TokenKeys;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
}

const invalidRequest = (detail: string): AppError => new AppError('invalid_request', { detail });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The requested scope, checked; the default when absent. 400 `invalid_scope` otherwise. */
function checkScope(scope: unknown): string {
  if (scope === undefined) return DEFAULT_SCOPE;
  const scopes = typeof scope === 'string' ? scope.split(' ') : [];
  if (
    scopes.length === 0 ||
    !scopes.every((s) => PUBLIC_SCOPES.has(s)) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new AppError('invalid_scope', { detail: 'The scope is not valid for this client.' });
  }
  return scopes.join(' ');
}

/** `path` (an authorize URL relative to the API) sealed for the login page, valid one hour. */
export function signReturnTo(keys: TokenKeys, path: string, nowMs: number): Promise<string> {
  return signJwt(
    keys,
    { url: path },
    { typ: RETURN_TO_TYPE, audience: RETURN_TO_AUDIENCE, ttlS: RETURN_TO_TTL_S, nowMs },
  );
}

/**
 * The authorize URL sealed in `signed`, or null when it is not a valid, unexpired `return_to` of
 * ours. Login lanes redirect to the result (relative to the API's origin) and to nothing else.
 */
export async function openReturnTo(
  keys: TokenKeys,
  signed: unknown,
  nowMs: number,
): Promise<string | null> {
  if (typeof signed !== 'string' || signed === '') return null;
  try {
    const payload = await verifyJwt(keys, signed, {
      typ: RETURN_TO_TYPE,
      audience: RETURN_TO_AUDIENCE,
      nowMs,
    });
    const url = payload['url'];
    return typeof url === 'string' && url.startsWith(`${AUTHORIZE_PATH}?`) ? url : null;
  } catch {
    return null;
  }
}

/** Checks authorize requests and builds the redirects. */
export class Authorizer {
  private readonly now: () => number;

  constructor(private readonly deps: AuthorizerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The checked request. Client and redirect URI first, so nothing after them can send a browser
   * anywhere unregistered; throws 401 `invalid_client`, 400 `invalid_request` or `invalid_scope`.
   */
  check(query: unknown): AuthorizeRequest {
    const params = isRecord(query) ? query : {};
    if (Object.values(params).some((value) => typeof value !== 'string')) {
      throw invalidRequest('A parameter appears more than once.');
    }
    const clientId = params['client_id'];
    if (!(CLIENT_IDS as readonly unknown[]).includes(clientId)) {
      throw new AppError('invalid_client', { detail: 'The client is not known.' });
    }
    const redirectUri = params['redirect_uri'];
    if (!this.deps.redirects.allows(clientId as ClientId, redirectUri)) {
      throw invalidRequest('The redirect_uri is not registered for this client.');
    }
    if (params['response_type'] !== 'code') throw invalidRequest('response_type must be code.');
    if (params['code_challenge_method'] !== 'S256') {
      throw invalidRequest('code_challenge_method must be S256.');
    }
    const codeChallenge = params['code_challenge'];
    if (!isS256Challenge(codeChallenge)) {
      throw invalidRequest('code_challenge must be an S256 challenge (43 base64url characters).');
    }
    const state = params['state'];
    if (typeof state !== 'string' || state === '' || state.length > MAX_STATE_LENGTH) {
      throw invalidRequest(`state is required (at most ${MAX_STATE_LENGTH} characters).`);
    }
    return {
      clientId: clientId as ClientId,
      redirectUri: redirectUri as string,
      codeChallenge,
      state,
      scope: checkScope(params['scope']),
    };
  }

  /** The login page, carrying `requestUrl` (this authorize request) as a signed `return_to`. */
  async loginRedirect(requestUrl: string): Promise<string> {
    if (requestUrl.length > MAX_RETURN_TO_PATH_LENGTH)
      throw invalidRequest('The request is too long.');
    const url = new URL(this.deps.loginUrl);
    url.searchParams.set('return_to', await signReturnTo(this.deps.keys, requestUrl, this.now()));
    return url.href;
  }

  /** A new code for `userId`, on the request's redirect URI with `state` echoed unchanged. */
  async codeRedirect(request: AuthorizeRequest, userId: string): Promise<string> {
    const code = await this.deps.codes.issue(
      {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        userId,
        scope: request.scope,
      },
      this.now(),
    );
    // Registered URIs carry no query or fragment, so the parameters start one.
    return `${request.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(request.state)}`;
  }
}

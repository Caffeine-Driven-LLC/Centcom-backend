/**
 * Google sign-in (B015): the authorize URL (scopes `openid email profile`, `state`, `nonce`, PKCE
 * S256), the code exchange, and the identity from the ID token, which is verified in full before
 * anything in it is believed: an RS256 signature by a key of Google's JWKS, `iss`, `aud` (our
 * client id), `exp` (60 s skew), our `nonce`, and `email_verified` true. Tokens are dropped after.
 *
 * Owns: talking to Google. Must not: trust an ID token that fails any check, use userinfo of an
 * unverified token, or keep or log a token or code.
 */
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from 'jose';
import type { ProviderClient } from './config.js';
import {
  formBody,
  requestJson,
  SocialLoginError,
  type ProviderCall,
  type ProviderIdentity,
} from './provider.js';

/** Google's endpoints and issuers. */
export const GOOGLE = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  scope: 'openid email profile',
});

/** How long the JWKS is reused, and how soon an unknown `kid` may trigger a refetch. */
export const GOOGLE_JWKS_MAX_AGE_MS = 60 * 60 * 1000;
export const GOOGLE_JWKS_REFETCH_MS = 60 * 1000;
/** Clock skew allowed on `exp`/`iat`. */
export const ID_TOKEN_SKEW_S = 60;

/** Where to send the browser. */
export function googleAuthorizeUrl(
  client: ProviderClient,
  redirectUri: string,
  state: string,
  challenge: string,
  nonce: string,
): string {
  const url = new URL(GOOGLE.authorize);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE.scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** Google's signing keys, fetched through the injected `fetch` and cached. */
export class GoogleKeys {
  private keys: JSONWebKeySet | undefined;
  private fetchedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly call: ProviderCall,
    private readonly now: () => number,
    private readonly url: string = GOOGLE.jwks,
  ) {}

  /** The key set, from cache when fresh (or when `refresh` was asked too soon after the last fetch). */
  async get(refresh = false): Promise<JSONWebKeySet> {
    const age = this.now() - this.fetchedAt;
    const stale = this.keys === undefined || age >= GOOGLE_JWKS_MAX_AGE_MS;
    if (this.keys !== undefined && !stale && !(refresh && age >= GOOGLE_JWKS_REFETCH_MS))
      return this.keys;
    const body = await requestJson(this.call, 'google', this.url, {
      headers: { accept: 'application/json' },
    });
    const keys = Array.isArray(body) ? undefined : body['keys'];
    if (!Array.isArray(keys)) throw new SocialLoginError('provider', 'google');
    this.keys = { keys: keys as JSONWebKeySet['keys'] };
    this.fetchedAt = this.now();
    return this.keys;
  }
}

/** The checked claims of a Google ID token. */
export interface GoogleIdClaims {
  sub: string;
  email: string;
  name?: string;
}

/**
 * Verifies a Google ID token: signature (RS256, a JWKS key; an unknown `kid` refetches the JWKS
 * once), `iss`, `aud`, `exp`, `nonce`, `email_verified`. Throws `invalid_identity` for any failed
 * check and `no_verified_email` for a token without a verified address.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; keys: GoogleKeys; nowMs: number },
): Promise<GoogleIdClaims> {
  const verify = async (keySet: JSONWebKeySet) =>
    jwtVerify(idToken, createLocalJWKSet(keySet), {
      algorithms: ['RS256'],
      issuer: [...GOOGLE.issuers],
      audience: opts.clientId,
      clockTolerance: ID_TOKEN_SKEW_S,
      currentDate: new Date(opts.nowMs),
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    });
  let payload: Record<string, unknown>;
  try {
    try {
      ({ payload } = await verify(await opts.keys.get()));
    } catch (err) {
      if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
      // Google rotates keys; a token signed by a new one is worth one fresh look at the JWKS.
      ({ payload } = await verify(await opts.keys.get(true)));
    }
  } catch (err) {
    if (err instanceof SocialLoginError) throw err;
    throw new SocialLoginError('invalid_identity', 'google', { cause: err });
  }
  const { sub, nonce, email, email_verified: verified, name } = payload;
  if (typeof sub !== 'string' || sub === '' || sub.length > 255 || nonce !== opts.nonce) {
    throw new SocialLoginError('invalid_identity', 'google');
  }
  if (typeof email !== 'string' || email === '' || verified !== true) {
    throw new SocialLoginError('no_verified_email', 'google');
  }
  return { sub, email, ...(typeof name === 'string' && name.trim() !== '' ? { name } : {}) };
}

/** Exchanges the code and verifies who signed in. */
export async function googleIdentity(
  call: ProviderCall,
  client: ProviderClient,
  redirectUri: string,
  code: string,
  verifier: string,
  nonce: string,
  keys: GoogleKeys,
  nowMs: number,
): Promise<ProviderIdentity> {
  const token = await requestJson(call, 'google', GOOGLE.token, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret.reveal(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const idToken = Array.isArray(token) ? undefined : token['id_token'];
  if (typeof idToken !== 'string' || idToken === '') throw new SocialLoginError('denied', 'google');
  const claims = await verifyGoogleIdToken(idToken, {
    clientId: client.clientId,
    nonce,
    keys,
    nowMs,
  });
  return {
    provider: 'google',
    subject: claims.sub,
    email: claims.email,
    ...(claims.name === undefined ? {} : { name: claims.name }),
  };
}

/**
 * JWTs (B017): access tokens (RFC 9068 profile, CT-AUTH) and the shared signing helper relay
 * tickets use. Tokens are signed EdDSA (Ed25519) with the active key and carry its `kid`; a token
 * verifies against any published key. Only `alg=EdDSA` is accepted, so `none` and HMAC tokens
 * (algorithm confusion) fail, and the clock may be off by 60 s at most (CT-IDS).
 *
 * Owns: signing and checking tokens. Must not: accept another algorithm or a larger skew, tell a
 * caller more than "expired" or "invalid" about a bad token, or log a token.
 */
import { randomBytes } from 'node:crypto';
import { isId } from '@centcom/contracts';
import { AppError } from '@centcom/core';
import { errors, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { TokenKeys } from './config.js';
import { verificationKey } from './keys.js';

/** CT-AUTH issuer of every token. */
export const TOKEN_ISSUER = 'https://api.centcom.dev';
/** Audience of access tokens. */
export const API_AUDIENCE = 'centcom-api';
/** Access token lifetime: 15 min. */
export const ACCESS_TOKEN_TTL_S = 900;
/** The most two clocks may disagree (CT-IDS). */
export const CLOCK_SKEW_S = 60;
/** RFC 9068's `typ` for access tokens, so no other JWT of ours passes as one. */
export const ACCESS_TOKEN_TYPE = 'at+jwt';
/** The only algorithm signed or accepted. */
export const ALGORITHM = 'EdDSA';

/** Plans an access token can carry (CT-ENTITLEMENTS). */
export type Plan = 'free' | 'pro' | 'team';
const PLANS: ReadonlySet<string> = new Set<Plan>(['free', 'pro', 'team']);

/** The claims of an access token (CT-AUTH). */
export interface AccessClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  /** Space-separated scopes. */
  scp: string;
  /** The device (`dev_…`); absent for API keys. */
  dev?: string;
  /** The active workspace (`wsp_…`), when there is one. */
  wsp?: string;
  plan: Plan;
  /** Entitlement revision. */
  ent: number;
}

/** What the caller decides about an access token; the rest is set when it is signed. */
export type AccessTokenInput = Pick<AccessClaims, 'sub' | 'scp' | 'plan' | 'ent'> &
  Partial<Pick<AccessClaims, 'dev' | 'wsp'>>;

/** A random token id: 128 bits, base64url. */
export const newJti = (): string => randomBytes(16).toString('base64url');

/** The 401s every bad access token gets: one detail per code, the same for every cause. */
export const tokenExpired = (): AppError =>
  new AppError('token_expired', { detail: 'The access token has expired.' });
export const tokenInvalid = (): AppError =>
  new AppError('token_invalid', { detail: 'The access token is not valid.' });

/** Signs `payload` with the active key: `typ`, `aud`, `iat` = now, `exp` = now + `ttlS`, a new `jti`. */
export async function signJwt(
  keys: TokenKeys,
  payload: JWTPayload,
  opts: { typ: string; audience: string; ttlS: number; nowMs: number; jti?: string },
): Promise<string> {
  const iat = Math.floor(opts.nowMs / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALGORITHM, kid: keys.active.kid, typ: opts.typ })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(opts.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + opts.ttlS)
    .setJti(opts.jti ?? newJti())
    .sign(keys.active.privateKey);
}

/** An access token for `input`, valid for 15 min from `nowMs`. */
export async function signAccessToken(
  keys: TokenKeys,
  input: AccessTokenInput,
  nowMs: number,
): Promise<{ token: string; claims: AccessClaims }> {
  const jti = newJti();
  const { sub, ...rest } = input;
  const token = await signJwt(
    keys,
    { sub, ...rest },
    { typ: ACCESS_TOKEN_TYPE, audience: API_AUDIENCE, ttlS: ACCESS_TOKEN_TTL_S, nowMs, jti },
  );
  const iat = Math.floor(nowMs / 1000);
  return {
    token,
    claims: {
      iss: TOKEN_ISSUER,
      aud: API_AUDIENCE,
      iat,
      exp: iat + ACCESS_TOKEN_TTL_S,
      jti,
      ...input,
    },
  };
}

/** The claims of a well-formed access token, or undefined. */
function accessClaims(payload: JWTPayload): AccessClaims | undefined {
  const { iss, sub, aud, exp, iat, jti, scp, dev, wsp, plan, ent } = payload as Record<
    string,
    unknown
  >;
  if (
    typeof iss !== 'string' ||
    !isId('usr', sub) ||
    typeof aud !== 'string' ||
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    typeof jti !== 'string' ||
    jti.length === 0 ||
    typeof scp !== 'string' ||
    (dev !== undefined && !isId('dev', dev)) ||
    (wsp !== undefined && !isId('wsp', wsp)) ||
    typeof plan !== 'string' ||
    !PLANS.has(plan) ||
    typeof ent !== 'number' ||
    !Number.isInteger(ent) ||
    ent < 0
  ) {
    return undefined;
  }
  return {
    iss,
    sub,
    aud,
    exp,
    iat,
    jti,
    scp,
    plan: plan as Plan,
    ent,
    ...(dev === undefined ? {} : { dev }),
    ...(wsp === undefined ? {} : { wsp }),
  };
}

/**
 * Verifies a JWT of ours: an EdDSA signature by a published key (by `kid`), the issuer, `aud`,
 * `typ`, and `exp`/`nbf`/`iat` within the 60 s skew. Rejects with the 401 `token_expired` for a
 * token that is valid but past `exp`, `token_invalid` for anything else.
 */
export async function verifyJwt(
  keys: TokenKeys,
  token: string,
  opts: { typ: string; audience: string; nowMs: number },
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(
      token,
      (header) => {
        const key = verificationKey(keys, header.kid);
        if (key === undefined) throw new errors.JWKSNoMatchingKey();
        return key;
      },
      {
        algorithms: [ALGORITHM],
        issuer: TOKEN_ISSUER,
        audience: opts.audience,
        typ: opts.typ,
        clockTolerance: CLOCK_SKEW_S,
        currentDate: new Date(opts.nowMs),
        requiredClaims: ['iat', 'exp', 'jti'],
      },
    );
    // jose checks `iat` only for a maximum age: a token from the future (beyond the skew) is not ours to trust.
    if (
      typeof payload.iat !== 'number' ||
      payload.iat > Math.floor(opts.nowMs / 1000) + CLOCK_SKEW_S
    )
      throw tokenInvalid();
    return payload;
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw tokenExpired();
    throw tokenInvalid();
  }
}

/** The claims of a valid access token; 401 `token_expired` or `token_invalid` otherwise. */
export async function verifyAccessJwt(
  keys: TokenKeys,
  token: string,
  nowMs: number,
): Promise<AccessClaims> {
  const payload = await verifyJwt(keys, token, {
    typ: ACCESS_TOKEN_TYPE,
    audience: API_AUDIENCE,
    nowMs,
  });
  const claims = accessClaims(payload);
  if (claims === undefined) throw tokenInvalid();
  return claims;
}

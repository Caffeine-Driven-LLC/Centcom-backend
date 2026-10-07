/**
 * OAuth state (B015): what a login remembers between sending the browser to the provider and the
 * callback. A random `state`, the PKCE verifier (S256), Google's `nonce` and the resolved
 * `return_to` travel in a cookie signed with HMAC-SHA256, valid 10 minutes, `HttpOnly`,
 * `SameSite=Lax` (sent on the provider's top-level redirect back) and scoped to `/login`. That
 * cookie ties the callback to the browser that started the login.
 *
 * Owns: making, sealing and opening the state. Must not: accept a state that is unsigned,
 * tampered with, expired or for another provider, or put the cookie's content in a log.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Secret } from '@centcom/core';
import type { IdentityProvider } from '@centcom/db';

/** A login has this long to come back from the provider. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** The cookie's name. */
export const STATE_COOKIE = 'centcom_oauth';
/** The cookie is only sent to the login routes. */
export const STATE_COOKIE_PATH = '/login';

/** What the state cookie holds. */
export interface OAuthState {
  provider: IdentityProvider;
  /** The `state` sent to the provider, 256 random bits. */
  state: string;
  /** The PKCE `code_verifier`, 256 random bits (43 characters). */
  verifier: string;
  /** Google's `nonce`, 256 random bits. */
  nonce?: string;
  /** The allow-listed URL the login returns to. */
  returnTo: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const random = (): string => randomBytes(32).toString('base64url');

/** A fresh state for a login with `provider`, expiring 10 minutes after `nowMs`. */
export function newOAuthState(
  provider: IdentityProvider,
  returnTo: string,
  nowMs: number,
): OAuthState {
  return {
    provider,
    state: random(),
    verifier: random(),
    ...(provider === 'google' ? { nonce: random() } : {}),
    returnTo,
    expiresAt: nowMs + STATE_TTL_MS,
  };
}

/** The S256 `code_challenge` of a verifier (RFC 7636). */
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

const sign = (payload: string, secret: Secret): Buffer =>
  createHmac('sha256', secret.reveal()).update(payload).digest();

/** `<payload>.<HMAC>`, both base64url. */
export function sealState(state: OAuthState, secret: Secret): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The state of a sealed cookie value, or undefined when it is missing, forged, malformed or expired. */
export function openState(
  sealed: string | undefined,
  secret: Secret,
  nowMs: number,
): OAuthState | undefined {
  if (sealed === undefined || sealed.length > 4096) return undefined;
  const [payload, mac, ...rest] = sealed.split('.');
  if (payload === undefined || mac === undefined || rest.length > 0) return undefined;
  const expected = sign(payload, secret);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { provider, state, verifier, nonce, returnTo, expiresAt } = parsed as Record<
    string,
    unknown
  >;
  if (
    (provider !== 'github' && provider !== 'google') ||
    !isString(state) ||
    !isString(verifier) ||
    (nonce !== undefined && !isString(nonce)) ||
    !isString(returnTo) ||
    typeof expiresAt !== 'number' ||
    nowMs >= expiresAt
  ) {
    return undefined;
  }
  return {
    provider,
    state,
    verifier,
    ...(nonce === undefined ? {} : { nonce }),
    returnTo,
    expiresAt,
  };
}

/** True when two state strings are equal, compared in constant time. */
export function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The Set-Cookie header that stores a sealed state. */
export function stateCookieHeader(sealed: string, secure: boolean): string {
  return [
    `${STATE_COOKIE}=${sealed}`,
    `Path=${STATE_COOKIE_PATH}`,
    `Max-Age=${STATE_TTL_MS / 1000}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The Set-Cookie header that removes the state cookie. */
export function clearStateCookieHeader(secure: boolean): string {
  return [
    `${STATE_COOKIE}=`,
    `Path=${STATE_COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The value of cookie `name` in a Cookie header (the first one wins). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

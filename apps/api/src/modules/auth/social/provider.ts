/**
 * What GitHub and Google sign-in share (B015): the identity a provider vouches for, the ways a
 * login fails, and JSON over HTTP with a 5 s limit through an injected `fetch`.
 *
 * Owns: the failure vocabulary. Must not: put a code, token, secret or e-mail address in an
 * error message (errors are logged by reason and provider only).
 */
import type { IdentityProvider } from '@centcom/db';

/** `fetch` as the providers use it; tests inject a fake provider. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Every provider call gives up after this long. */
export const PROVIDER_TIMEOUT_MS = 5_000;

/** Who a provider says is signing in: an account id that never changes, and a verified e-mail. */
export interface ProviderIdentity {
  provider: IdentityProvider;
  /** GitHub's numeric user id, Google's `sub`. */
  subject: string;
  /** Verified by the provider. */
  email: string;
  /** A display name the account offers, if any. */
  name?: string;
}

/**
 * Why a login failed:
 * - `state`: the callback's state is missing, forged, expired or for another login;
 * - `denied`: the user or the provider declined (an OAuth error, a rejected code);
 * - `provider`: the provider was down, slow (5 s) or answered nonsense;
 * - `no_verified_email`: the account has no verified e-mail we may use;
 * - `invalid_identity`: the provider's identity did not check out (an ID token, an id).
 */
export type SocialLoginFailure =
  'state' | 'denied' | 'provider' | 'no_verified_email' | 'invalid_identity';

/** A failed social login. The message is safe to log; `cause` is not. */
export class SocialLoginError extends Error {
  constructor(
    readonly reason: SocialLoginFailure,
    readonly provider: IdentityProvider,
    options?: { cause?: unknown },
  ) {
    super(`${provider} sign-in failed: ${reason}`, options);
  }
}
Object.defineProperty(SocialLoginError.prototype, 'name', {
  value: 'SocialLoginError',
  writable: true,
  configurable: true,
});

/** How provider calls are made. */
export interface ProviderCall {
  fetch: Fetch;
  timeoutMs: number;
}

/**
 * Calls a provider and reads its JSON. A timeout, network error, 5xx or unreadable body is a
 * `provider` failure; a 4xx carrying an OAuth `error` is `denied`.
 */
export async function requestJson(
  call: ProviderCall,
  provider: IdentityProvider,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> | unknown[]> {
  let res: Response;
  try {
    res = await call.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(call.timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    throw new SocialLoginError('provider', provider, { cause: err });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new SocialLoginError('provider', provider, { cause: err });
  }
  if (res.status >= 500 || typeof body !== 'object' || body === null) {
    throw new SocialLoginError('provider', provider, { cause: new Error(`status ${res.status}`) });
  }
  if (!res.ok)
    throw new SocialLoginError('denied', provider, { cause: new Error(`status ${res.status}`) });
  return body as Record<string, unknown> | unknown[];
}

/** A form body for a token endpoint. */
export const formBody = (fields: Record<string, string>): URLSearchParams =>
  new URLSearchParams(fields);

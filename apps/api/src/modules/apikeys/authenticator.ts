/**
 * API-key authentication (B019, CT-AUTH): the principal resolver the token service (B017) calls
 * for `cen_live_…` and `cen_test_…` bearers. A key is looked up by its peppered hash and compared
 * in constant time; then:
 *
 * - unknown, malformed or not matching: 401 `token_invalid` (one body, no oracle);
 * - revoked, or of a deleted workspace: 401 `token_revoked`, from the next request on (no cache);
 * - past its `expires_at`: 401 `token_expired`;
 * - otherwise the principal `{kind: 'api_key', keyId, workspaceId, scopes}`.
 *
 * `last_used_at` is written at most once a minute per key, after the answer and off its path; a
 * failed write is counted and logged and never fails the request.
 *
 * Owns: turning keys into principals. Must not: log a key or its hash, or let a key act as a user.
 */
import {
  AppError,
  noopMetrics,
  unavailable,
  type Actor,
  type Logger,
  type Metrics,
  type Secret,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import type { Principal, PrincipalResolver, TokenService } from '../auth/tokens/service.js';
import { API_KEY_PREFIXES, API_KEY_SHAPE, hashApiKey, hashesEqual } from './generate.js';
import type { ApiKeyStore } from './repo.js';

/** `last_used_at` is written at most this often per key. */
export const LAST_USED_INTERVAL_MS = 60_000;
/** Keys whose last write this process remembers, to skip the database between writes. */
export const LAST_USED_MEMORY = 10_000;
/** Counter of failed `last_used_at` writes. */
export const LAST_USED_FAILURES_METRIC = 'api_key_last_used_failures_total';

const DETAILS = Object.freeze({
  invalid: 'The API key is not valid.',
  revoked: 'The API key was revoked.',
  expired: 'The API key has expired.',
});

/** Dependencies of the authenticator. */
export interface ApiKeyAuthenticatorDeps {
  store: Pick<ApiKeyStore, 'findByHash' | 'touch'>;
  pepper: Secret<string>;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The resolver, and `settled()` for tests to await the `last_used_at` writes in flight. */
export interface ApiKeyAuthenticator {
  resolve: PrincipalResolver;
  settled(): Promise<void>;
}

/** Builds the resolver (see the file comment). */
export function createApiKeyAuthenticator(deps: ApiKeyAuthenticatorDeps): ApiKeyAuthenticator {
  const now = deps.now ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  const lastWrite = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();

  const touch = (keyId: string, at: number): void => {
    const last = lastWrite.get(keyId);
    if (last !== undefined && at - last < LAST_USED_INTERVAL_MS) return;
    lastWrite.delete(keyId);
    lastWrite.set(keyId, at);
    // Forget the oldest when full (Map keeps insertion order; touched keys move to the end).
    if (lastWrite.size > LAST_USED_MEMORY) {
      const oldest = lastWrite.keys().next().value;
      if (oldest !== undefined) lastWrite.delete(oldest);
    }
    const write = deps.store
      .touch(keyId, new Date(at), LAST_USED_INTERVAL_MS)
      .then(
        () => undefined,
        () => {
          metrics.counter(LAST_USED_FAILURES_METRIC).inc();
          deps.logger?.warn({ key_id: keyId }, 'api_key.last_used_failed');
        },
      )
      .finally(() => inFlight.delete(write));
    inFlight.add(write);
  };

  const resolve: PrincipalResolver = async (credential) => {
    if (!API_KEY_SHAPE.test(credential)) {
      throw new AppError('token_invalid', { detail: DETAILS.invalid });
    }
    const hash = hashApiKey(credential, deps.pepper);
    let key;
    try {
      key = await deps.store.findByHash(hash);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      throw unavailable(undefined, undefined, { cause: new Error('database unavailable') });
    }
    if (key === null || !hashesEqual(key.keyHash, hash)) {
      throw new AppError('token_invalid', { detail: DETAILS.invalid });
    }
    if (key.revokedAt !== null || !key.workspaceLive) {
      throw new AppError('token_revoked', { detail: DETAILS.revoked });
    }
    const at = now();
    if (key.expiresAt !== null && at >= key.expiresAt.getTime()) {
      throw new AppError('token_expired', { detail: DETAILS.expired });
    }
    touch(key.id, at);
    return {
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: key.workspaceId,
      scopes: key.scopes,
      keyId: key.id,
    };
  };

  return {
    resolve,
    async settled() {
      await Promise.all([...inFlight]);
    },
  };
}

/** Registers the resolver for both key prefixes. */
export function registerApiKeyAuthenticator(
  tokens: TokenService,
  authenticator: ApiKeyAuthenticator,
): void {
  for (const prefix of API_KEY_PREFIXES)
    tokens.registerPrincipalResolver(prefix, authenticator.resolve);
}

/** The RBAC actor (B021) of a principal: a user, an API key, or null for anything else. */
export function principalActor(principal: Principal | null): Actor | null {
  if (principal === null) return null;
  if (principal.kind === 'user' && principal.userId !== null) {
    return { kind: 'user', userId: principal.userId, scopes: principal.scopes };
  }
  if (
    principal.kind === 'api_key' &&
    principal.keyId !== undefined &&
    principal.workspaceId !== null
  ) {
    return {
      kind: 'api_key',
      keyId: principal.keyId,
      workspaceId: principal.workspaceId,
      scopes: principal.scopes,
    };
  }
  return null;
}

/**
 * The `authorization_code` grant (B018, RFC 6749 §4.1.3 and RFC 7636 §4.6), registered with B017's
 * token endpoint through `registerGrantHandler`. It claims the code (single use), checks that the
 * request's `client_id` and `redirect_uri` are the ones the code was issued for and that the
 * `code_verifier` matches its S256 challenge, then has the token service issue tokens.
 *
 * Every failure about the code itself (unknown, expired, used, bound elsewhere, wrong verifier) is
 * the same 400 `invalid_grant`. A replayed code also revokes what its first exchange issued: the
 * access token by `jti` and the refresh token's family.
 *
 * Owns: the exchange. Must not: log a code, verifier or token, issue tokens for a code twice, or
 * tell a caller which check failed.
 */
import { AppError, type Logger } from '@centcom/core';
import { decodeJwt } from 'jose';
import type { GrantHandler, TokenService } from '../tokens/service.js';
import type { AuthorizationCodeStore, IssuedTokens } from './code-store.js';
import { isCodeVerifier, verifyS256 } from './pkce.js';

/** The grant type it answers. */
export const AUTHORIZATION_CODE_GRANT = 'authorization_code';

/** Dependencies of the grant. */
export interface AuthorizationCodeGrantDeps {
  tokens: TokenService;
  codes: AuthorizationCodeStore;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  logger?: Logger;
}

/** The one answer for a code that cannot be exchanged. */
const invalidGrant = (): AppError =>
  new AppError('invalid_grant', {
    detail: 'The authorization code is invalid, expired or already used.',
  });

/** Revokes what an exchange issued; the refresh token only when it could be opened. */
async function revokeIssued(tokens: TokenService, issued: IssuedTokens): Promise<void> {
  await tokens.revokeAccessJti(issued.jti, issued.exp);
  if (issued.refreshToken !== undefined) {
    await tokens.revokeRefreshToken(issued.refreshToken, issued.userId);
  }
}

/** The handler for `grant_type=authorization_code`. */
export function authorizationCodeGrant(deps: AuthorizationCodeGrantDeps): GrantHandler {
  const { tokens, codes, logger } = deps;
  const now = deps.now ?? Date.now;
  return async (request) => {
    const { code, code_verifier: verifier, redirect_uri: redirectUri } = request;
    if (typeof code !== 'string' || code === '' || typeof redirectUri !== 'string') {
      throw new AppError('invalid_request', {
        detail: 'code, code_verifier and redirect_uri are required.',
      });
    }
    if (!isCodeVerifier(verifier)) {
      throw new AppError('invalid_request', {
        detail: 'code_verifier must be 43 to 128 characters of A-Z, a-z, 0-9 and -._~',
      });
    }

    const claim = await codes.claim(code, now());
    if (claim.kind === 'replayed') {
      if (claim.issued !== null) await revokeIssued(tokens, claim.issued);
      logger?.warn(
        { client_id: request.client_id, revoked: claim.issued !== null },
        'auth.code_reuse_detected: tokens issued from the code revoked',
      );
      throw invalidGrant();
    }
    if (claim.kind === 'unknown') throw invalidGrant();
    const { grant } = claim;
    if (
      grant.clientId !== request.client_id ||
      grant.redirectUri !== redirectUri ||
      !verifyS256(verifier, grant.codeChallenge)
    ) {
      throw invalidGrant();
    }

    const response = await tokens.issueTokens({
      userId: grant.userId,
      deviceId: null,
      scopes: grant.scope.split(' '),
      clientId: grant.clientId,
    });
    const { jti, exp } = decodeJwt(response.access_token);
    const issued: IssuedTokens = {
      userId: grant.userId,
      jti: String(jti),
      exp: Number(exp),
      refreshToken: response.refresh_token,
    };
    if (await codes.recordIssued(code, issued)) {
      // A replay arrived while these tokens were being issued: nobody gets to keep them.
      await revokeIssued(tokens, issued);
      logger?.warn(
        { client_id: request.client_id, revoked: true },
        'auth.code_reuse_detected: tokens issued from the code revoked',
      );
      throw invalidGrant();
    }
    return response;
  };
}

/** Registers the grant with the token service's endpoint (`POST /v1/auth/token`). */
export function registerAuthorizationCodeGrant(deps: AuthorizationCodeGrantDeps): void {
  deps.tokens.registerGrantHandler(AUTHORIZATION_CODE_GRANT, authorizationCodeGrant(deps));
}

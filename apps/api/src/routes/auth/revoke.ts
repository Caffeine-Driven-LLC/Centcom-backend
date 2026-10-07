/**
 * `POST /v1/auth/revoke` (B017, RFC 7009, CT-AUTH): an authenticated user revokes one of their
 * refresh tokens (its whole family) or one of their devices. Unknown tokens and devices, and other
 * users' ones, get the same 200 as a revocation: the answer tells nothing.
 *
 * Owns: the endpoint. Must not: reveal whether a token or device exists, or revoke another
 * user's credentials.
 */
import { isId } from '@centcom/contracts';
import { AppError, validationFailed, type FieldError } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { TokenService } from '../../modules/auth/tokens/service.js';

/** Options for `revokeRoutes`. */
export interface RevokeRouteOptions {
  tokens: TokenService;
}

/** Longer than any refresh token; longer input is refused before any lookup. */
const MAX_TOKEN_LENGTH = 512;

export const revokeRoutes: FastifyPluginAsync<RevokeRouteOptions> = async (app, { tokens }) => {
  app.post(
    '/v1/auth/revoke',
    { config: { auth: { scopes: ['profile'] } } },
    async (request, reply) => {
      const userId = request.principal?.userId ?? null;
      if (userId === null)
        throw new AppError('forbidden', { detail: 'Only a user can revoke their credentials.' });
      const body: unknown = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw validationFailed([
          { pointer: '', code: 'invalid_type', detail: 'must be an object' },
        ]);
      }
      const { token, token_type_hint: hint, device } = body as Record<string, unknown>;
      const issues: FieldError[] = [];
      if (
        token !== undefined &&
        (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
      ) {
        issues.push({
          pointer: '/token',
          code: 'invalid_type',
          detail: `must be a string of 1 to ${MAX_TOKEN_LENGTH} characters`,
        });
      }
      if (hint !== undefined && hint !== 'refresh_token') {
        issues.push({
          pointer: '/token_type_hint',
          code: 'invalid_value',
          detail: 'must be refresh_token',
        });
      }
      if (device !== undefined && !isId('dev', device)) {
        issues.push({
          pointer: '/device',
          code: 'invalid_format',
          detail: 'must be a device id (dev_…)',
        });
      }
      if (issues.length > 0) throw validationFailed(issues);
      if (token === undefined && device === undefined) {
        throw new AppError('invalid_request', { detail: 'Provide token or device.' });
      }
      if (typeof token === 'string') await tokens.revokeRefreshToken(token, userId);
      if (typeof device === 'string') await tokens.revokeOwnDevice(device, userId);
      return reply.code(200).send();
    },
  );
};

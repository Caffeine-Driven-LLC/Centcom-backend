/**
 * `POST /v1/auth/token` (B017, CT-AUTH): the OAuth token endpoint. Takes
 * `application/x-www-form-urlencoded` (RFC 6749) or JSON, checks `client_id` against the public
 * clients and the web client's CSRF header, and hands the request to the handler registered for
 * its `grant_type` (`refresh_token` built in; device code B016, authorization code B018).
 * Responses carry `Cache-Control: no-store` (RFC 6749 §5.1).
 *
 * Owns: parsing and dispatch. Must not: accept a repeated parameter, or put a token anywhere but
 * the response body.
 */
import { AppError } from '@centcom/core';
import type { ClientId } from '@centcom/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  CLIENT_IDS,
  type TokenRequest,
  type TokenService,
} from '../../modules/auth/tokens/service.js';

/** Options for `tokenRoutes`. */
export interface TokenRouteOptions {
  tokens: TokenService;
}

const invalidRequest = (detail: string): AppError => new AppError('invalid_request', { detail });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses a form body; a repeated parameter is refused (RFC 6749 §3.1). */
export function parseForm(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    if (Object.hasOwn(fields, key)) throw invalidRequest('A parameter appears more than once.');
    fields[key] = value;
  }
  return fields;
}

export const tokenRoutes: FastifyPluginAsync<TokenRouteOptions> = async (app, { tokens }) => {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parseForm(String(body)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/v1/auth/token', { config: { auth: false } }, async (request, reply) => {
    const body = request.body;
    if (
      !isRecord(body) ||
      typeof body['grant_type'] !== 'string' ||
      typeof body['client_id'] !== 'string'
    ) {
      throw invalidRequest('grant_type and client_id are required.');
    }
    const clientId = body['client_id'];
    if (!(CLIENT_IDS as readonly string[]).includes(clientId)) {
      throw new AppError('invalid_client', { detail: 'The client is not known.' });
    }
    if (clientId === 'centcom-web' && request.headers['x-centcom-client'] !== 'web') {
      throw invalidRequest('Web clients must send X-Centcom-Client: web.');
    }
    const handler = tokens.grantHandler(body['grant_type']);
    if (handler === undefined) throw invalidRequest('The grant_type is not supported.');
    const response = await handler({
      ...body,
      grant_type: body['grant_type'],
      client_id: clientId as ClientId,
    } satisfies TokenRequest);
    void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    return response;
  });
};

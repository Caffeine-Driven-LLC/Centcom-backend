/**
 * `/v1/me` (B022, CT-API-ACCOUNTS), scope `profile`, users only:
 *
 * - `GET /v1/me` → 200 `{user, plan, active_workspace, ent}` with the user's `ETag`;
 * - `PATCH /v1/me` with any of `{display_name, locale, avatar, telemetry}` → 200 `User` with the
 *   new `ETag`. `If-Match` makes it conditional (412 `precondition_failed` on a stale ETag).
 *   Unknown fields are ignored (CT-VER); an empty body is a 422.
 *
 * The caller comes from `caller(request)` (the B017 auth plugin's principal); it may throw the
 * 401 token errors. No caller is 401; an API key or a missing `profile` scope is 403.
 *
 * Owns: the HTTP side of the account. Must not: accept email, id or status, or cache a response
 * in shared caches.
 */
import { AppError, hasScope, notFound, validationFailed, type FieldError } from '@centcom/core';
import type { ProfilePatch } from '@centcom/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { computeEtag, parseIfMatch } from '../modules/me/etag.js';
import type { MeService } from '../modules/me/service.js';
import { checkAvatarSlot, checkDisplayName, checkLocale } from '../modules/users/index.js';

/** Who calls, as the authentication plugin knows it. */
export type Caller =
  | { kind: 'user'; userId: string; scopes: readonly string[]; workspaceId?: string }
  | { kind: 'api_key'; scopes: readonly string[] };

/** Options for `meRoutes`. */
export interface MeRouteOptions {
  me: MeService;
  /** The request's caller, null when unauthenticated; may throw the 401 token errors. */
  caller: (request: FastifyRequest) => Caller | null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `false` for public routes (the B017 auth plugin reads it); else the scopes the caller must hold. */
    auth?: false | { scopes?: readonly string[] };
  }
}

/** The fields of `MeUpdate`, by API name. */
const UPDATE_FIELDS = ['display_name', 'locale', 'avatar', 'telemetry'] as const;

/**
 * The profile patch of a `MeUpdate` body: known fields checked with the users module's rules
 * (pointers by API name), unknown fields ignored (CT-VER). A validation AppError lists every bad
 * field; a body that is not an object or has no field at all is refused too.
 */
export function parseMeUpdate(body: unknown): ProfilePatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length === 0) {
    throw validationFailed([
      { pointer: '', code: 'too_few', detail: 'must name at least one field' },
    ]);
  }
  const issues: FieldError[] = [];
  const patch: ProfilePatch = {};
  for (const field of UPDATE_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (field === 'display_name') {
      const checked = checkDisplayName(value, '/display_name');
      issues.push(...checked.issues);
      if (checked.value !== undefined) patch.display_name = checked.value;
    } else if (field === 'locale') {
      const checked = checkLocale(value, '/locale');
      issues.push(...checked.issues);
      if (checked.value !== undefined) patch.locale = checked.value;
    } else if (field === 'avatar') {
      const checked = checkAvatarSlot(value, '/avatar');
      issues.push(...checked.issues);
      if (checked.value !== undefined) patch.avatar_slot = checked.value;
    } else if (typeof value === 'boolean') {
      patch.telemetry_opt_in = value;
    } else {
      issues.push({ pointer: '/telemetry', code: 'invalid_type', detail: 'must be true or false' });
    }
  }
  if (issues.length > 0) throw validationFailed(issues, 'Some fields are not valid.');
  return patch;
}

/** The calling user, or the 401/403 the request deserves. */
function userOf(
  request: FastifyRequest,
  opts: MeRouteOptions,
): { userId: string; workspaceId?: string } {
  const caller = opts.caller(request);
  if (caller === null)
    throw new AppError('unauthorized', { detail: 'Authentication is required.' });
  if (caller.kind !== 'user')
    throw new AppError('forbidden', { detail: 'Only a user has an account.' });
  if (!hasScope(caller, 'profile')) {
    throw new AppError('forbidden', {
      detail: 'The credential does not hold a scope this request needs.',
    });
  }
  return {
    userId: caller.userId,
    ...(caller.workspaceId === undefined ? {} : { workspaceId: caller.workspaceId }),
  };
}

/** Account data: never in shared caches; revalidate with the ETag. */
const privateHeaders = (reply: FastifyReply, version: string): FastifyReply =>
  reply.header('etag', computeEtag({ version })).header('cache-control', 'private, no-cache');

export const meRoutes: FastifyPluginAsync<MeRouteOptions> = async (app, opts) => {
  app.get('/v1/me', { config: { auth: { scopes: ['profile'] } } }, async (request, reply) => {
    const caller = userOf(request, opts);
    const view = await opts.me.get(caller);
    if (view === null) throw notFound('There is no such account.');
    privateHeaders(reply, view.version);
    return view.me;
  });

  app.patch('/v1/me', { config: { auth: { scopes: ['profile'] } } }, async (request, reply) => {
    const caller = userOf(request, opts);
    const patch = parseMeUpdate(request.body);
    const result = await opts.me.update(caller, patch, parseIfMatch(request.headers['if-match']));
    if (result === 'missing') throw notFound('There is no such account.');
    if (result === 'stale') {
      throw new AppError('precondition_failed', {
        detail: 'The account changed since that ETag; read it again.',
      });
    }
    privateHeaders(reply, result.version);
    return result.user;
  });
};

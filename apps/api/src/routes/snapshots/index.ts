/**
 * Session snapshot routes (B056, CT-API-SESSIONS, CT-RESUME), users only:
 *
 * - `POST /v1/sessions/{id}/snapshot` (`beginSnapshotUpload`, scope `sessions:host`, host):
 *   `SnapshotBegin {size, kid?}` -> 201 `SnapshotUpload {snp, upload_url, expires_in}`.
 * - `POST /v1/sessions/{id}/snapshot/{snp}/commit` (`commitSnapshot`, scope `sessions:host`,
 *   host): `SnapshotCommit {seq, sha256, size, kid}` -> 200 `SnapshotDescriptor`.
 * - `GET /v1/sessions/{id}/snapshot` (`getSnapshot`, scope `sessions:read`, participants): 200
 *   `SnapshotDescriptor` with `download_url` and `expires_in`; 404 `snapshot_missing` when there is
 *   no committed snapshot.
 *
 * Both POSTs accept an `Idempotency-Key` (B024): the same key and body replay the stored answer
 * with `Idempotency-Replayed: true`; begin's is kept encrypted (it holds the upload URL). No caller
 * is 401; an API key, or a token without the scope, is 403. Every answer is
 * `Cache-Control: private, no-store`, replays included (set before B024's hook). Register after the
 * request-context, error-handler, auth and idempotency plugins.
 *
 * Owns: the HTTP side. Must not: log a URL or a hash, or take an object key from the request.
 */
import { isId, validate, type Api } from '@centcom/contracts';
import { AppError, hasScope, notFound, validationFailed } from '@centcom/core';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';
import {
  SNAPSHOT_DETAILS,
  type LatestSnapshot,
  type SnapshotCaller,
  type SnapshotService,
} from '../../modules/snapshots/service.js';
import type { SnapshotDescriptor } from '../../modules/snapshots/ports.js';

/** Options for `snapshotRoutes`. */
export interface SnapshotRouteOptions {
  service: Pick<SnapshotService, 'begin' | 'commit' | 'latestFor'>;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const SNAPSHOT_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a session participant can use its snapshots; API keys cannot.',
  scope: 'The credential does not hold a scope this request needs.',
} as const);

/** The calling user; 401 without a caller, 403 for an API key or a missing `scope`. */
function callerOf(
  request: FastifyRequest,
  scope: 'sessions:read' | 'sessions:host',
): SnapshotCaller {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: SNAPSHOT_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: SNAPSHOT_ROUTE_DETAILS.usersOnly });
  }
  if (!hasScope(principal, scope)) {
    throw new AppError('forbidden', { detail: SNAPSHOT_ROUTE_DETAILS.scope });
  }
  return {
    userId: principal.userId,
    ...(isId('req', request.id) ? { requestId: request.id } : {}),
  };
}

/** The session id of the path; 404 for anything that is not one. */
function sessionOf(request: FastifyRequest): string {
  const sid = String((request.params as Record<string, unknown>)['id'] ?? '');
  if (!isId('ses', sid)) throw notFound(SNAPSHOT_DETAILS.notFound);
  return sid;
}

/** The snapshot id of the path; 404 `snapshot_missing` for anything that is not one. */
function snapshotOf(request: FastifyRequest): string {
  const snp = String((request.params as Record<string, unknown>)['snp'] ?? '');
  if (!isId('snp', snp))
    throw new AppError('snapshot_missing', { detail: SNAPSHOT_DETAILS.missing });
  return snp;
}

/** A descriptor as CT-API-SESSIONS' `SnapshotDescriptor`. */
export function descriptorBody(
  d: SnapshotDescriptor,
  download?: Pick<LatestSnapshot, 'downloadUrl' | 'expiresIn'>,
): Api.SnapshotDescriptor {
  return {
    snp: d.snp as Api.SnapshotDescriptor['snp'],
    seq: d.seq,
    size: d.size,
    sha256: d.sha256,
    kid: d.kid,
    created_at: d.createdAt.toISOString(),
    ...(download === undefined
      ? {}
      : { download_url: download.downloadUrl, expires_in: download.expiresIn }),
  };
}

/** Before B024's hook, so a replayed answer (content headers only) has it too. */
const noStore: onRequestHookHandler = (_request, reply, done) => {
  void reply.header('cache-control', 'private, no-store');
  done();
};

const privately = (reply: FastifyReply): FastifyReply =>
  reply.header('cache-control', 'private, no-store');

export const snapshotRoutes: FastifyPluginAsync<SnapshotRouteOptions> = async (app, opts) => {
  app.post(
    '/v1/sessions/:id/snapshot',
    {
      onRequest: noStore,
      config: {
        auth: { scopes: ['sessions:host'] },
        idempotency: 'accepted',
        sensitiveResponse: true,
      },
    },
    async (request, reply) => {
      const caller = callerOf(request, 'sessions:host');
      const sid = sessionOf(request);
      const checked = validate('api/SnapshotBegin', request.body ?? {});
      if (!checked.ok) throw validationFailed(checked.errors, SNAPSHOT_DETAILS.invalid);
      const grant = await opts.service.begin(sid, caller, checked.value);
      privately(reply).code(201);
      const body: Api.SnapshotUpload = {
        snp: grant.snp as Api.SnapshotUpload['snp'],
        upload_url: grant.uploadUrl,
        expires_in: grant.expiresIn,
      };
      return body;
    },
  );

  app.post(
    '/v1/sessions/:id/snapshot/:snp/commit',
    {
      onRequest: noStore,
      config: { auth: { scopes: ['sessions:host'] }, idempotency: 'accepted' },
    },
    async (request, reply) => {
      const caller = callerOf(request, 'sessions:host');
      const sid = sessionOf(request);
      const snp = snapshotOf(request);
      const checked = validate('api/SnapshotCommit', request.body ?? {});
      if (!checked.ok) throw validationFailed(checked.errors, SNAPSHOT_DETAILS.invalid);
      const descriptor = await opts.service.commit(sid, snp, checked.value, caller);
      privately(reply);
      return descriptorBody(descriptor);
    },
  );

  app.get(
    '/v1/sessions/:id/snapshot',
    { config: { auth: { scopes: ['sessions:read'] } } },
    async (request, reply) => {
      const caller = callerOf(request, 'sessions:read');
      const sid = sessionOf(request);
      const latest = await opts.service.latestFor(sid, caller);
      privately(reply);
      return descriptorBody(latest.descriptor, latest);
    },
  );
};

/**
 * request.audit (B036, card test audit.request-helper.test.ts): on a small Fastify app with the
 * request-context, error-handler, RBAC and audit plugins, the helper fills in the actor (the
 * request's user or API key), the request id (the X-Request-Id it answered with) and the
 * workspace (`:id` of /v1/workspaces/:id routes, else the API key's) from the request; writes in
 * the handler's transaction; queues detached events, written when the app closes; and keeps what
 * an input names itself. Without an actor, the transactional path fails the request and a
 * detached event is counted as dropped. RBAC denials reach the log with their request id.
 */
import { newId } from '@centcom/contracts';
import {
  createAuditEmitter,
  createAuthorizer,
  rbacAuditSink,
  type Actor,
  type AuditDb,
  type AuditEmitter,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import type { CompiledQuery, QueryResult } from 'kysely';
import { describe, expect, it } from 'vitest';
import { auditPlugin, type AuditPluginOptions } from '../src/plugins/audit.js';
import { errorHandlerPlugin } from '../src/plugins/error-handler.js';
import { rbacPlugin, requirePermission } from '../src/plugins/rbac.js';
import { requestContextPlugin } from '../src/plugins/request-context.js';
import { captureLogger, recordingMetrics } from './helpers.js';

const USER = newId('usr');
const WORKSPACE = newId('wsp');
const OTHER_WORKSPACE = newId('wsp');
const API_KEY = newId('key');
const MEMBERSHIP = newId('mem');
const WEBHOOK = newId('whk');
const SESSION = newId('ses');

/** A pool (or transaction) that keeps the rows of the audit inserts it runs. */
type RecordingDb = AuditDb & { rows: Record<string, unknown>[] };
function recordingDb(isTransaction: boolean): RecordingDb {
  const rows: Record<string, unknown>[] = [];
  return {
    isTransaction,
    rows,
    executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>> {
      const list = /\(([^)]+)\) values/.exec(query.sql)?.[1] ?? '';
      const columns = list.split(', ').map((c) => c.replaceAll('"', ''));
      for (let at = 0; at < query.parameters.length; at += columns.length) {
        rows.push(Object.fromEntries(columns.map((c, i) => [c, query.parameters[at + i]])));
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

/** Who the test headers say is calling: `x-test-user`, or `x-test-key` of `x-test-key-workspace`. */
function actorOf(headers: Record<string, unknown>): Actor | null {
  const user = headers['x-test-user'];
  const key = headers['x-test-key'];
  if (typeof key === 'string') {
    const workspaceId = String(headers['x-test-key-workspace']);
    return { kind: 'api_key', keyId: key, workspaceId, scopes: ['webhooks:write'] };
  }
  return typeof user === 'string' ? { kind: 'user', userId: user, scopes: [] } : null;
}

interface TestApp {
  server: FastifyInstance;
  db: RecordingDb;
  trx: RecordingDb;
  emitter: AuditEmitter;
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
}

/** The app, with the role `USER` holds in WORKSPACE (none by default) and audit options. */
async function app(
  role?: 'owner' | 'member',
  options: Omit<AuditPluginOptions, 'emitter'> = {},
): Promise<TestApp> {
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const db = recordingDb(false);
  const trx = recordingDb(true);
  const emitter = createAuditEmitter({ db, logger: captured.logger, metrics: recorded.metrics });
  const authorizer = createAuthorizer({
    memberships: {
      workspaceRole: (_user, workspace) =>
        Promise.resolve(workspace === WORKSPACE ? (role ?? null) : null),
      sessionRole: () => Promise.resolve(null),
    },
    audit: rbacAuditSink(emitter),
  });
  const server = fastify({ logger: false });
  await server.register(requestContextPlugin, { logger: captured.logger });
  await server.register(errorHandlerPlugin, { logger: captured.logger });
  await server.register(rbacPlugin, { authorizer, actor: (request) => actorOf(request.headers) });
  await server.register(auditPlugin, { emitter, ...options });
  const param = (request: { params: unknown }, name: string): string =>
    (request.params as Record<string, string>)[name] ?? '';
  // Handlers write in "their transaction": the recording one.
  server.post('/v1/workspaces/:id/members/:mem/role', async (request) => ({
    id: await request.audit(trx, {
      action: 'member.role_change',
      target: { type: 'membership', id: param(request, 'mem') },
      meta: { to_role: 'admin' },
    }),
  }));
  server.patch('/v1/webhooks/:id', async (request) => ({
    id: await request.audit(trx, {
      action: 'webhook.update',
      target: { type: 'webhook', id: param(request, 'id') },
      meta: { fields: 'url' },
    }),
  }));
  server.post('/v1/sessions/:id/end', async (request) => ({
    id: await request.audit(trx, {
      action: 'session.end',
      actor: { type: 'system', id: 'relay' },
      workspaceId: OTHER_WORKSPACE,
      target: { type: 'session', id: param(request, 'id') },
      outcome: 'failed',
      meta: { reason: 'host_left' },
    }),
  }));
  server.post('/v1/api-keys/:id/revoke', async (request) => ({
    id: await request.audit(trx, {
      action: 'api_key.revoke',
      workspaceId: null,
      target: { type: 'api_key', id: param(request, 'id') },
    }),
  }));
  server.post('/v1/workspaces/:id/refused', async (request, reply) => {
    request.audit.detached({
      action: 'control.kick',
      outcome: 'denied',
      meta: { session_id: SESSION },
    });
    return reply.code(403).send({ refused: true });
  });
  server.delete(
    '/v1/workspaces/:id',
    {
      preHandler: requirePermission('workspace.delete', (request) => ({
        workspaceId: param(request, 'id'),
      })),
    },
    async () => ({ deleted: true }),
  );
  await server.ready();
  return { server, db, trx, emitter, captured, recorded };
}

const asUser = { 'x-test-user': USER };
const asKey = (workspace: string): Record<string, string> => ({
  'x-test-key': API_KEY,
  'x-test-key-workspace': workspace,
});

describe('request.audit', () => {
  it("fills in the actor, request id and workspace from a user's request", async () => {
    const { server, db, trx, emitter } = await app('owner');
    expect(server.audit).toBe(emitter);
    const res = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/members/${MEMBERSHIP}/role`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(trx.rows).toEqual([
      {
        id: res.json<{ id: string }>().id,
        workspace_id: WORKSPACE,
        actor_type: 'user',
        actor_id: USER,
        action: 'member.role_change',
        target_type: 'membership',
        target_id: MEMBERSHIP,
        outcome: 'success',
        request_id: res.headers['x-request-id'],
        meta: '{"to_role":"admin"}',
        created_at: expect.any(Date) as Date,
      },
    ]);
    expect(db.rows).toEqual([]);
    // A valid request id the client sent is the one recorded.
    const requestId = newId('req');
    await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/members/${MEMBERSHIP}/role`,
      headers: { ...asUser, 'x-request-id': requestId },
    });
    expect(trx.rows[1]?.['request_id']).toBe(requestId);
    await server.close();
  });

  it("takes the route's workspace first, then an API key's, and none for a user elsewhere", async () => {
    const { server, trx } = await app();
    const inject = (method: 'POST' | 'PATCH', url: string, headers: Record<string, string>) =>
      server.inject({ method, url, headers });
    await inject('PATCH', `/v1/webhooks/${WEBHOOK}`, asKey(WORKSPACE));
    await inject('PATCH', `/v1/webhooks/${WEBHOOK}`, asUser);
    await inject(
      'POST',
      `/v1/workspaces/${WORKSPACE}/members/${MEMBERSHIP}/role`,
      asKey(OTHER_WORKSPACE),
    );
    // Only /v1/workspaces/:id names a workspace: an id of that shape elsewhere does not.
    await inject('PATCH', `/v1/webhooks/${WORKSPACE}`, asUser);
    expect(trx.rows.map((r) => [r['actor_type'], r['actor_id'], r['workspace_id']])).toEqual([
      ['api_key', API_KEY, WORKSPACE],
      ['user', USER, null],
      ['api_key', API_KEY, WORKSPACE],
      ['user', USER, null],
    ]);
    await server.close();
  });

  it('keeps the actor, workspace and outcome an input names', async () => {
    const { server, trx } = await app();
    const ended = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${SESSION}/end`,
      headers: asUser,
    });
    const revoked = await server.inject({
      method: 'POST',
      url: `/v1/api-keys/${API_KEY}/revoke`,
      headers: asKey(WORKSPACE),
    });
    expect(trx.rows).toMatchObject([
      {
        actor_type: 'system',
        actor_id: 'relay',
        workspace_id: OTHER_WORKSPACE,
        outcome: 'failed',
        request_id: ended.headers['x-request-id'],
      },
      { actor_type: 'api_key', workspace_id: null, request_id: revoked.headers['x-request-id'] },
    ]);
    await server.close();
  });

  it('queues detached events, and the app writes them when it closes', async () => {
    const { server, db } = await app('member');
    const refused = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/refused`,
      headers: asUser,
    });
    expect(refused.statusCode).toBe(403);
    // A member may not delete the workspace: RBAC records the denial through the same emitter.
    const denied = await server.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${WORKSPACE}`,
      headers: asUser,
    });
    expect(denied.statusCode).toBe(403);
    // Detached events wait up to 250 ms; closing the app flushes them.
    await server.close();
    expect(db.rows).toMatchObject([
      {
        action: 'control.kick',
        outcome: 'denied',
        workspace_id: WORKSPACE,
        actor_id: USER,
        request_id: refused.headers['x-request-id'],
        meta: JSON.stringify({ session_id: SESSION }),
      },
      {
        action: 'permission.denied',
        outcome: 'denied',
        workspace_id: WORKSPACE,
        actor_id: USER,
        request_id: denied.headers['x-request-id'],
        meta: JSON.stringify({ attempted: 'workspace.delete', reason: 'role' }),
      },
    ]);
  });

  it('fails a request without an actor, and counts a detached event without one as dropped', async () => {
    const { server, trx, captured, recorded } = await app();
    const res = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/members/${MEMBERSHIP}/role`,
    });
    expect(res.statusCode).toBe(500);
    expect(trx.rows).toEqual([]);
    const refused = await server.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/refused`,
    });
    expect(refused.statusCode).toBe(403);
    expect(recorded.count('audit_events_dropped_total', { reason: 'invalid' })).toBe(1);
    expect(captured.lines().filter((l) => l['msg'] === 'audit.dropped')).toHaveLength(1);
    await server.close();
  });

  it('uses the actor and workspace functions it is given, and counts a failing one', async () => {
    const custom = await app(undefined, {
      actor: () => ({ type: 'system', id: 'scheduler' }),
      workspace: () => OTHER_WORKSPACE,
    });
    await custom.server.inject({ method: 'PATCH', url: `/v1/webhooks/${WEBHOOK}` });
    expect(custom.trx.rows).toMatchObject([
      { actor_type: 'system', actor_id: 'scheduler', workspace_id: OTHER_WORKSPACE },
    ]);
    await custom.server.close();
    const broken = await app(undefined, {
      actor: () => {
        throw new Error('no principal store');
      },
    });
    const res = await broken.server.inject({ method: 'PATCH', url: `/v1/webhooks/${WEBHOOK}` });
    expect(res.statusCode).toBe(500);
    const refused = await broken.server.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/refused`,
    });
    expect(refused.statusCode).toBe(403);
    expect(broken.recorded.count('audit_events_dropped_total', { reason: 'invalid' })).toBe(1);
    await broken.server.close();
  });
});

/**
 * The RBAC plugin (B021, card test plugin.test.ts): `requirePermission` answers a denial with a
 * 403 problem+json and an audit record, or 404 on routes that hide their resources; no actor is
 * 401; `requireScope` checks the credential's scopes; allowed requests reach the handler.
 */
import {
  createAuthorizer,
  type Actor,
  type MembershipReader,
  type RbacDeniedEvent,
  type SessionRole,
  type WorkspaceRole,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../src/plugins/error-handler.js';
import { rbacPlugin, requirePermission, requireScope } from '../src/plugins/rbac.js';
import { requestContextPlugin } from '../src/plugins/request-context.js';
import { captureLogger } from './helpers.js';

const USER = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const WORKSPACE = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const OTHER_WORKSPACE = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4X';

/** The app with a header-driven actor (`x-test-user`, `x-test-scopes`) and two guarded routes. */
async function app(
  roles: Record<string, WorkspaceRole>,
): Promise<{ app: FastifyInstance; audit: RbacDeniedEvent[] }> {
  const audit: RbacDeniedEvent[] = [];
  const memberships: MembershipReader = {
    workspaceRole: (userId, workspaceId) =>
      Promise.resolve(roles[`${userId}|${workspaceId}`] ?? null),
    sessionRole: (): Promise<SessionRole | null> => Promise.resolve(null),
  };
  const authorizer = createAuthorizer({
    memberships,
    audit: { record: (event) => Promise.resolve(void audit.push(event)) },
  });
  const captured = captureLogger();
  const server = fastify({ logger: false });
  await server.register(requestContextPlugin, { logger: captured.logger });
  await server.register(errorHandlerPlugin, { logger: captured.logger });
  await server.register(rbacPlugin, {
    authorizer,
    actor: (request): Actor | null => {
      const userId = request.headers['x-test-user'];
      if (typeof userId !== 'string') return null;
      const scopes = String(request.headers['x-test-scopes'] ?? '')
        .split(' ')
        .filter(Boolean);
      return { kind: 'user', userId, scopes };
    },
  });
  const workspaceOf = (request: { params: unknown }) => ({
    workspaceId: (request.params as { id: string }).id,
  });
  server.patch(
    '/v1/workspaces/:id',
    {
      preHandler: [
        requireScope('workspaces:write'),
        requirePermission('workspace.update', workspaceOf),
      ],
    },
    async () => ({ updated: true }),
  );
  server.get(
    '/v1/workspaces/:id/audit',
    { preHandler: requirePermission('audit.read', workspaceOf, { hideAs404: true }) },
    async () => ({ events: [] }),
  );
  await server.ready();
  return { app: server, audit };
}

const as = (scopes = 'workspaces:write audit:read'): Record<string, string> => ({
  'x-test-user': USER,
  'x-test-scopes': scopes,
});

describe('the RBAC plugin', () => {
  it('lets an allowed request through to the handler', async () => {
    const { app: server, audit } = await app({ [`${USER}|${WORKSPACE}`]: 'admin' });
    const res = await server.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${WORKSPACE}`,
      headers: as(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: true });
    expect(audit).toEqual([]);
    await server.close();
  });

  it('answers a denial with 403 problem+json and one audit record', async () => {
    const { app: server, audit } = await app({ [`${USER}|${WORKSPACE}`]: 'member' });
    const res = await server.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${WORKSPACE}`,
      headers: as(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({
      code: 'forbidden',
      status: 403,
      detail: 'You do not have permission to do this.',
    });
    expect(audit).toEqual([
      expect.objectContaining({
        attempted: 'workspace.update',
        actor: { kind: 'user', id: USER },
        resource: { workspaceId: WORKSPACE },
      }),
    ]);
    await server.close();
  });

  it("forbids another workspace's resource, and can hide it as 404 instead", async () => {
    const { app: server } = await app({ [`${USER}|${WORKSPACE}`]: 'owner' });
    expect(
      (
        await server.inject({
          method: 'PATCH',
          url: `/v1/workspaces/${OTHER_WORKSPACE}`,
          headers: as(),
        })
      ).statusCode,
    ).toBe(403);
    const hidden = await server.inject({
      url: `/v1/workspaces/${OTHER_WORKSPACE}/audit`,
      headers: as(),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'not_found' });
    expect(
      (await server.inject({ url: `/v1/workspaces/${WORKSPACE}/audit`, headers: as() })).statusCode,
    ).toBe(200);
    await server.close();
  });

  it('answers 401 without an actor and 403 without the scope', async () => {
    const { app: server } = await app({ [`${USER}|${WORKSPACE}`]: 'owner' });
    const anonymous = await server.inject({ method: 'PATCH', url: `/v1/workspaces/${WORKSPACE}` });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'unauthorized' });
    const noAnonymousAudit = await server.inject({ url: `/v1/workspaces/${WORKSPACE}/audit` });
    expect(noAnonymousAudit.statusCode).toBe(401);
    const scopeless = await server.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${WORKSPACE}`,
      headers: as('workspaces:read'),
    });
    expect(scopeless.statusCode).toBe(403);
    expect(scopeless.json()).toMatchObject({ code: 'forbidden' });
    await server.close();
  });
});

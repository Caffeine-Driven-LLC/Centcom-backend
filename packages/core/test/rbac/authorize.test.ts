/**
 * `authorize` (B021 acceptance 7 and 8, failure modes): roles come from membership state only; a
 * denied privileged action writes exactly one audit record with ids and throws 403 `forbidden`
 * with a detail that says nothing; allowed actions and denied reads write none; another
 * workspace's resource is forbidden; a membership read that fails denies with 503; an audit sink
 * that fails does not turn a denial into an allow.
 */
import { describe, expect, it } from 'vitest';
import {
  AppError,
  createAuthorizer,
  FORBIDDEN_DETAIL,
  type AuditSink,
  type Logger,
  type Metrics,
  type RbacDeniedEvent,
} from '../../src/index.js';
import {
  ACTOR_ID,
  memoryMemberships,
  OTHER_ID,
  OTHER_WORKSPACE,
  SESSION,
  user,
  WORKSPACE,
} from './helpers.js';

const T0 = Date.parse('2026-10-07T12:00:00.000Z');

function recordingAudit(): AuditSink & { events: RbacDeniedEvent[]; fail: boolean } {
  const sink = {
    events: [] as RbacDeniedEvent[],
    fail: false,
    record(event: RbacDeniedEvent): Promise<void> {
      if (sink.fail) return Promise.reject(new Error('audit store down'));
      sink.events.push(event);
      return Promise.resolve();
    },
  };
  return sink;
}

function recorders(): {
  logger: Logger;
  logged: unknown[][];
  metrics: Metrics;
  counts: Map<string, number>;
} {
  const logged: unknown[][] = [];
  const counts = new Map<string, number>();
  const log = (...args: unknown[]): void => void logged.push(args);
  const logger = {
    level: 'info',
    isLevelEnabled: () => true,
    fatal: log,
    error: log,
    warn: log,
    info: log,
    debug: log,
    trace: log,
    child: () => logger,
  } as unknown as Logger;
  const metrics: Metrics = {
    counter: (name, labels) => ({
      inc: (n = 1) =>
        void counts.set(
          `${name}${JSON.stringify(labels ?? {})}`,
          (counts.get(`${name}${JSON.stringify(labels ?? {})}`) ?? 0) + n,
        ),
    }),
    histogram: () => ({ observe: () => undefined }),
  };
  return { logger, logged, metrics, counts };
}

function setup() {
  const memberships = memoryMemberships();
  const audit = recordingAudit();
  const recorded = recorders();
  const authorizer = createAuthorizer({
    memberships,
    audit,
    logger: recorded.logger,
    metrics: recorded.metrics,
    now: () => T0,
  });
  return { memberships, audit, authorizer, ...recorded };
}

describe('authorize', () => {
  it('allows from the role membership state gives, writing no audit record', async () => {
    const { memberships, audit, authorizer } = setup();
    memberships.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'admin');
    await expect(
      authorizer.authorize(user(), 'workspace.update', { workspaceId: WORKSPACE }),
    ).resolves.toBeUndefined();
    memberships.session.set(`${ACTOR_ID}|${SESSION}`, 'host');
    await expect(
      authorizer.authorize(user(), 'session.control', { sessionId: SESSION }),
    ).resolves.toBeUndefined();
    expect(audit.events).toEqual([]);
  });

  it('writes exactly one audit record with actor, action and resource ids for a denied privileged action (acceptance 7)', async () => {
    const { memberships, audit, authorizer, counts } = setup();
    memberships.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'member');
    const err = await authorizer
      .authorize(user(), 'workspace.delete', { workspaceId: WORKSPACE, ownerUserId: OTHER_ID })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'forbidden', status: 403, detail: FORBIDDEN_DETAIL });
    expect(audit.events).toEqual([
      {
        action: 'rbac.denied',
        actor: { kind: 'user', id: ACTOR_ID },
        attempted: 'workspace.delete',
        resource: { workspaceId: WORKSPACE, ownerUserId: OTHER_ID },
        reason: 'role',
        at: '2026-10-07T12:00:00.000Z',
      },
    ]);
    expect(counts.get('rbac_denied_total{"action":"workspace.delete"}')).toBe(1);
  });

  it('does not audit denied reads, which are not privileged', async () => {
    const { audit, authorizer } = setup();
    await expect(
      authorizer.authorize(user(), 'workspace.read', { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      authorizer.authorize(user(), 'session.history.read', { sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(audit.events).toEqual([]);
  });

  it("forbids acting on another workspace's resource (acceptance 8)", async () => {
    const { memberships, audit, authorizer } = setup();
    memberships.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'owner');
    await expect(
      authorizer.authorize(user(), 'workspace.update', { workspaceId: OTHER_WORKSPACE }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(audit.events).toMatchObject([
      { reason: 'not_a_member', resource: { workspaceId: OTHER_WORKSPACE } },
    ]);
    // API keys too: their own workspace only.
    const key = {
      kind: 'api_key',
      keyId: 'key_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      workspaceId: WORKSPACE,
      scopes: ['workspaces:write'],
    } as const;
    await expect(
      authorizer.authorize(key, 'workspace.update', { workspaceId: OTHER_WORKSPACE }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(audit.events.at(-1)).toMatchObject({
      actor: { kind: 'api_key', id: key.keyId, workspaceId: WORKSPACE },
      reason: 'other_workspace',
    });
  });

  it('denies with 503, never allows, when membership cannot be read (failure mode)', async () => {
    const { memberships, audit, authorizer } = setup();
    memberships.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'owner');
    memberships.fail = true;
    const err = await authorizer
      .authorize(user(), 'workspace.read', { workspaceId: WORKSPACE })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(audit.events).toEqual([]);
  });

  it('keeps the denial when the audit sink fails, counting and logging the lost record (failure mode)', async () => {
    const { audit, authorizer, counts, logged } = setup();
    audit.fail = true;
    await expect(
      authorizer.authorize(user(), 'billing.manage', { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(counts.get('rbac_audit_failures_total{}')).toBe(1);
    expect(logged.at(-1)?.[1]).toBe('rbac.audit_failed');
  });

  it('never trusts a role the caller claims: only membership state counts', async () => {
    const { authorizer } = setup();
    // The resource claims a role for the caller; membership state has none.
    const claimed = { workspaceId: WORKSPACE, targetRole: 'owner', newRole: 'owner' } as const;
    await expect(authorizer.authorize(user(), 'workspace.delete', claimed)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await authorizer.decide(user(), 'workspace.delete', claimed)).toEqual({
      allow: false,
      reason: 'not_a_member',
    });
  });

  it('passes server-side facts through: a delegated approver may approve tool calls', async () => {
    const { memberships, authorizer } = setup();
    memberships.session.set(`${ACTOR_ID}|${SESSION}`, 'editor');
    await expect(
      authorizer.authorize(user(), 'session.tool.approve', { sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      authorizer.authorize(
        user(),
        'session.tool.approve',
        { sessionId: SESSION },
        { delegatedApprover: true },
      ),
    ).resolves.toBeUndefined();
  });
});

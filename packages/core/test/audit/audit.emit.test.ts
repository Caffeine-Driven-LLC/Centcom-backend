/**
 * The audit emitter's transactional path (B036, card test audit.emit.test.ts, without a
 * database): one insert per event, in the transaction it is given, with a new `aud_` ULID; ids in
 * emission order; every field checked before anything is written (InvalidAuditEventError,
 * InvalidAuditActionError, whose messages name fields and never values); database errors passed
 * on; the catalogue (CT-API-AUDIT's stable names) and its extension; and the RBAC sink (CT-RBAC
 * rule 6). Commit and rollback on Postgres: packages/db/test/audit/audit.emit.test.ts.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_LATENCY_BUCKETS_MS,
  createAuditEmitter,
  createAuthorizer,
  defineAuditActions,
  deniedEvent,
  InvalidAuditActionError,
  InvalidAuditEventError,
  rbacAuditSink,
  runWithContext,
  type Actor,
  type AuditEmitter,
  type AuditEvent,
  type MembershipReader,
} from '../../src/index.js';
import { fakeDb, IDS, pgError, recordingMetrics, sampleEvent } from './helpers.js';

const AUD_ID = /^aud_[0-9A-HJKMNP-TV-Z]{26}$/;
const AT = Date.UTC(2026, 9, 7, 12, 0, 0);

/** An emitter over fake databases, with a frozen clock. */
function setup(): {
  emitter: AuditEmitter;
  db: ReturnType<typeof fakeDb>;
  trx: ReturnType<typeof fakeDb>;
  recorded: ReturnType<typeof recordingMetrics>;
} {
  const db = fakeDb();
  const trx = fakeDb(true);
  const recorded = recordingMetrics();
  const emitter = createAuditEmitter({ db, metrics: recorded.metrics, clock: () => AT });
  return { emitter, db, trx, recorded };
}

describe('emit', () => {
  it('writes one row in the transaction it is given and returns its aud_ id', async () => {
    const { emitter, db, trx } = setup();
    const id = await emitter.emit(trx, sampleEvent());
    expect(id).toMatch(AUD_ID);
    expect(db.queries).toEqual([]);
    expect(trx.queries).toHaveLength(1);
    // A plain insert: a duplicate id would be an error here, not a silent no-op.
    expect(trx.queries[0]?.sql).not.toContain('on conflict');
    expect(trx.rows).toEqual([
      {
        id,
        workspace_id: IDS.workspace,
        actor_type: 'user',
        actor_id: IDS.user,
        action: 'member.role_change',
        target_type: 'membership',
        target_id: IDS.membership,
        outcome: 'success',
        request_id: IDS.request,
        meta: JSON.stringify({ user_id: IDS.member, from_role: 'member', to_role: 'admin' }),
        created_at: new Date(AT),
      },
    ]);
  });

  it('gives every event a new id, in the order the events were emitted', async () => {
    const { emitter, trx } = setup();
    const ids: string[] = [];
    // The clock is frozen: ids stay unique and ordered within one millisecond.
    for (let i = 0; i < 1000; i++) ids.push(await emitter.emit(trx, sampleEvent()));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
    expect(trx.rows.map((r) => r['id'])).toEqual(ids);
  });

  it('stores what is left out as null, and events outside any workspace', async () => {
    const { emitter, trx } = setup();
    await emitter.emit(trx, {
      workspaceId: null,
      actor: { type: 'device', id: IDS.device },
      action: 'auth.device_revoked',
      outcome: 'success',
    });
    await emitter.emit(trx, {
      workspaceId: IDS.workspace,
      actor: { type: 'system', id: 'retention' },
      action: 'history.purge',
      target: { type: 'session', id: IDS.session },
      outcome: 'failed',
      meta: { frames: 0, blobs: 12 },
    });
    expect(trx.rows).toMatchObject([
      {
        workspace_id: null,
        actor_type: 'device',
        actor_id: IDS.device,
        target_type: null,
        target_id: null,
        request_id: null,
        meta: '{}',
      },
      {
        actor_type: 'system',
        actor_id: 'retention',
        outcome: 'failed',
        meta: '{"frames":0,"blobs":12}',
      },
    ]);
  });

  it('refuses to write outside a transaction', async () => {
    const { emitter, db, trx } = setup();
    await expect(emitter.emit(db, sampleEvent())).rejects.toThrow(TypeError);
    await expect(emitter.emit(undefined as never, sampleEvent())).rejects.toThrow(TypeError);
    expect([...db.queries, ...trx.queries]).toEqual([]);
  });

  it('refuses an unknown action, at compile time and at run time', async () => {
    const { emitter, trx } = setup();
    const promote = { ...sampleEvent(), action: 'member.promote' };
    // @ts-expect-error: 'member.promote' is not an audit action
    const refused = emitter.emit(trx, promote);
    await expect(refused).rejects.toThrow(InvalidAuditActionError);
    await expect(refused).rejects.toThrow('unknown audit action "member.promote"');
    // Input that is not even shaped like an action is not echoed.
    const odd = { ...sampleEvent(), action: 'ada@example.com' } as unknown as AuditEvent;
    const err = await emitter.emit(trx, odd).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidAuditEventError);
    expect(String(err)).not.toContain('ada@example.com');
    const missing = { ...sampleEvent(), action: 42 } as unknown as AuditEvent;
    await expect(emitter.emit(trx, missing)).rejects.toThrow(InvalidAuditActionError);
    expect(trx.queries).toEqual([]);
  });

  it.each([
    ['a workspace that is not a wsp_ id', { workspaceId: 'acme' }, /workspaceId/],
    ['a usr_ id as the workspace', { workspaceId: IDS.user }, /workspaceId/],
    ['no workspace at all', { workspaceId: undefined }, /workspaceId/],
    ['no actor', { actor: undefined }, /actor is required/],
    ['an unknown actor type', { actor: { type: 'robot', id: IDS.user } }, /actor\.type/],
    ['a user that is not a usr_ id', { actor: { type: 'user', id: IDS.device } }, /usr_ id/],
    ['an API key that is not a key_ id', { actor: { type: 'api_key', id: IDS.user } }, /key_ id/],
    ['a device that is not a dev_ id', { actor: { type: 'device', id: 'laptop' } }, /dev_ id/],
    ['a system actor that is not a name', { actor: { type: 'system', id: 'Relay 1' } }, /service/],
    ['a target id that is not an id', { target: { type: 'membership', id: 'x' } }, /target\.id/],
    [
      'a target type that is not snake_case',
      { target: { type: 'Member', id: IDS.membership } },
      /target\.type/,
    ],
    ['a target that is not an object', { target: 'membership' }, /target must be/],
    ['an unknown outcome', { outcome: 'ok' }, /outcome/],
    ['a request id that is not a req_ id', { requestId: 'abc' }, /requestId/],
    ['meta that is an array', { meta: ['owner'] }, /plain object/],
    ['meta that is a Map', { meta: new Map([['to_role', 'admin']]) }, /plain object/],
    ['a meta value that is an object', { meta: { to_role: { name: 'admin' } } }, /meta\.to_role/],
  ])('refuses %s, writing nothing', async (_name, overrides, message) => {
    const { emitter, trx } = setup();
    const event = { ...sampleEvent(), ...overrides } as unknown as AuditEvent;
    await expect(emitter.emit(trx, event)).rejects.toThrow(InvalidAuditEventError);
    await expect(emitter.emit(trx, event)).rejects.toThrow(message);
    expect(trx.queries).toEqual([]);
  });

  it('names fields in its errors, never the values it refused', async () => {
    const { emitter, trx } = setup();
    for (const overrides of [
      { workspaceId: 'ada@example.com' },
      { actor: { type: 'user', id: 'ada@example.com' } },
      { actor: { type: 'system', id: 'ada@example.com' } },
      { target: { type: 'user', id: 'ada@example.com' } },
      { requestId: 'ada@example.com' },
      { meta: { to_role: 'a'.repeat(300) + 'ada@example.com' } },
    ]) {
      const event = { ...sampleEvent(), ...overrides } as unknown as AuditEvent;
      const err = await emitter.emit(trx, event).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidAuditEventError);
      expect(String(err)).not.toContain('ada@example.com');
    }
    await expect(emitter.emit(trx, null as unknown as AuditEvent)).rejects.toThrow(
      'an audit event must be an object',
    );
  });

  it('passes database errors on, and counts and times only the events it wrote', async () => {
    const { emitter, trx, recorded } = setup();
    trx.failWith = () => pgError('23503', 'violates foreign key constraint');
    await expect(emitter.emit(trx, sampleEvent())).rejects.toMatchObject({ code: '23503' });
    expect(recorded.count('audit_events_written_total', { mode: 'emit' })).toBe(0);
    trx.failWith = undefined;
    await emitter.emit(trx, sampleEvent());
    expect(recorded.count('audit_events_written_total', { mode: 'emit' })).toBe(1);
    const latencies = recorded.observations.filter((o) => o.name === 'audit_emit_latency_ms');
    expect(latencies).toEqual([
      {
        name: 'audit_emit_latency_ms',
        buckets: AUDIT_LATENCY_BUCKETS_MS,
        value: expect.any(Number),
        labels: { mode: 'emit' },
      },
    ]);
  });
});

describe('emit with a broken metrics backend', () => {
  it('still writes, and resolves to the id', async () => {
    const boom = (): never => {
      throw new Error('metrics down');
    };
    const trx = fakeDb(true);
    const emitter = createAuditEmitter({
      db: fakeDb(),
      metrics: { counter: () => ({ inc: boom }), histogram: () => ({ observe: boom }) },
    });
    await expect(emitter.emit(trx, sampleEvent())).resolves.toMatch(AUD_ID);
    expect(trx.rows).toHaveLength(1);
  });
});

describe('the action catalogue', () => {
  it("holds exactly CT-API-AUDIT's stable action names", () => {
    const contract = readFileSync(
      new URL('../../../../contracts/02-rest-api.md', import.meta.url),
      'utf8',
    );
    const line = contract.split('\n').find((l) => l.startsWith('Audit `action` names (stable):'));
    const names = [...(line ?? '').matchAll(/`([a-z_]+)\.([a-z_|]+)`/g)].flatMap(
      ([, area, verbs]) => (verbs ?? '').split('|').map((verb) => `${area ?? ''}.${verb}`),
    );
    expect(names).toHaveLength(30);
    expect(Object.keys(AUDIT_ACTIONS).sort()).toEqual(names.sort());
  });

  it('allows only meta keys that name ids, enums, counts, flags or times', () => {
    const content = /text|body|path|branch|url|email|ip|token|secret|password|name|message|title/;
    for (const [action, rule] of Object.entries(AUDIT_ACTIONS)) {
      for (const key of rule.meta) {
        expect(key, action).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(key, action).not.toMatch(content);
      }
    }
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
    expect(Object.isFrozen(AUDIT_ACTIONS['member.add'].meta)).toBe(true);
  });

  it('can be extended, and the extended emitter accepts the new actions and their meta', async () => {
    const actions = defineAuditActions({ ...AUDIT_ACTIONS, 'project.create': { meta: ['plan'] } });
    const trx = fakeDb(true);
    const emitter = createAuditEmitter({ db: fakeDb(), actions });
    await emitter.emit(trx, {
      ...sampleEvent(),
      action: 'project.create',
      meta: { plan: 'pro', from_role: 'member' },
    });
    expect(trx.rows[0]).toMatchObject({ action: 'project.create', meta: '{"plan":"pro"}' });
    expect(Object.hasOwn(AUDIT_ACTIONS, 'project.create')).toBe(false);
    expect(Object.isFrozen(actions)).toBe(true);
  });

  it.each([
    [{ Workspace: { meta: [] } }, /area\.verb/],
    [{ 'workspace.Create': { meta: [] } }, /area\.verb/],
    [{ [`a.${'b'.repeat(64)}`]: { meta: [] } }, /area\.verb/],
    [{ 'project.create': { meta: ['Plan'] } }, /snake_case/],
    [{ 'project.create': { meta: ['plan-id'] } }, /snake_case/],
    [{ 'project.create': { meta: [42] as unknown as string[] } }, /snake_case/],
    [{ 'project.create': { meta: ['plan', 'plan'] } }, /twice/],
  ])('refuses a malformed catalogue %#', (actions, message) => {
    expect(() => defineAuditActions(actions)).toThrow(message);
  });
});

describe('the RBAC sink', () => {
  const member: Actor = { kind: 'user', userId: IDS.user, scopes: [] };
  const memberships: MembershipReader = {
    workspaceRole: () => Promise.resolve('member'),
    sessionRole: () => Promise.resolve('viewer'),
  };

  it('records a refused privileged action as permission.denied (CT-RBAC rule 6)', async () => {
    const events: AuditEvent[] = [];
    const authorizer = createAuthorizer({
      memberships,
      audit: rbacAuditSink({ emitDetached: (event) => void events.push(event) }),
    });
    await runWithContext({ requestId: IDS.request }, () =>
      expect(
        authorizer.authorize(member, 'workspace.delete', { workspaceId: IDS.workspace }),
      ).rejects.toMatchObject({ code: 'forbidden' }),
    );
    await expect(
      authorizer.authorize(member, 'session.control', {
        workspaceId: IDS.workspace,
        sessionId: IDS.session,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(events).toEqual([
      {
        workspaceId: IDS.workspace,
        actor: { type: 'user', id: IDS.user },
        action: 'permission.denied',
        outcome: 'denied',
        requestId: IDS.request,
        meta: { attempted: 'workspace.delete', reason: 'role' },
      },
      {
        workspaceId: IDS.workspace,
        actor: { type: 'user', id: IDS.user },
        action: 'permission.denied',
        target: { type: 'session', id: IDS.session },
        outcome: 'denied',
        meta: { attempted: 'session.control', reason: 'role' },
      },
    ]);
  });

  it('maps API keys to their workspace, drops malformed ids, and writes events the emitter accepts', async () => {
    const keyId = newId('key');
    const event = deniedEvent({
      action: 'rbac.denied',
      actor: { kind: 'api_key', id: keyId, workspaceId: IDS.workspace },
      attempted: 'apikey.manage.any',
      resource: { sessionId: 'not-a-session', ownerUserId: IDS.member },
      reason: 'scope',
      at: new Date(AT).toISOString(),
    });
    expect(event).toEqual({
      workspaceId: IDS.workspace,
      actor: { type: 'api_key', id: keyId },
      action: 'permission.denied',
      outcome: 'denied',
      meta: { attempted: 'apikey.manage.any', reason: 'scope', owner_user_id: IDS.member },
    });
    const odd = deniedEvent({
      action: 'rbac.denied',
      actor: { kind: 'user', id: IDS.user },
      attempted: 'workspace.update',
      resource: { workspaceId: 'acme', ownerUserId: 'someone' },
      reason: 'not_a_member',
      at: new Date(AT).toISOString(),
    });
    expect(odd.workspaceId).toBeNull();
    expect(odd.meta).toEqual({ attempted: 'workspace.update', reason: 'not_a_member' });
    const { emitter, trx } = setup();
    await emitter.emit(trx, event);
    await emitter.emit(trx, odd);
    expect(trx.rows).toHaveLength(2);
  });
});

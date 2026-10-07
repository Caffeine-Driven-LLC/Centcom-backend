/**
 * audit_events is append-only (B036, card test audit.immutability.test.ts, acceptance 2; on
 * Postgres 16 with DATABASE_URL, CI's integration job). UPDATE, DELETE and TRUNCATE fail with a
 * permission error from the table's trigger, for the owner (the role that runs migrations, a
 * superuser in CI) and for an application role that was granted every table privilege, which
 * cannot use the purge setting either. Kysely's types refuse updates at compile time. Old events
 * leave only through purge_audit_events(): one workspace (or the events outside any) at a time,
 * oldest first, at most its limit, and the purge leaves no way open for a DELETE after it. A
 * workspace with audit events cannot be deleted (no cascade into audit, CONVENTIONS).
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { createAuditEmitter } from '@centcom/core';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/index.js';
import {
  addWorkspace,
  ADMIN_URL,
  auditDatabase,
  event,
  onDatabase,
  type AuditTestDatabase,
} from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const APPEND_ONLY = /audit_events is append-only/;

describe.runIf(ADMIN_URL !== undefined)('audit_events on Postgres 16', () => {
  let t: AuditTestDatabase;
  /** A workspace with three events. */
  let workspaceId: string;
  beforeAll(async () => {
    t = await auditDatabase();
    workspaceId = await addWorkspace(t.db, t.userId);
    const emitter = createAuditEmitter({ db: t.db });
    for (let i = 0; i < 3; i++) {
      await withTransaction(t.db, (trx) => emitter.emit(trx, event(workspaceId, t.userId)));
    }
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  /** The error `statement` fails with, as the session `url` names (the owner by default). */
  const failure = (statement: string): Promise<unknown> =>
    onDatabase(t.url, (c) => c.query(statement)).then(
      () => undefined,
      (err: unknown) => err,
    );
  const outcomes = async (): Promise<string[]> =>
    (
      await t.db
        .selectFrom('audit_events')
        .select('outcome')
        .where('workspace_id', '=', workspaceId)
        .execute()
    ).map((r) => r.outcome);

  it('refuses UPDATE, DELETE and TRUNCATE from the table owner (acceptance 2)', async () => {
    for (const statement of [
      "update audit_events set outcome = 'failed'",
      'update audit_events set outcome = outcome where false',
      'delete from audit_events',
      'delete from audit_events where false',
      'truncate audit_events',
    ]) {
      const err = await failure(statement);
      expect(err, statement).toMatchObject({
        code: '42501',
        message: expect.stringMatching(APPEND_ONLY) as string,
      });
    }
    expect(await outcomes()).toEqual(['success', 'success', 'success']);
  });

  it('refuses updates in its Kysely types too', async () => {
    const err = await t.db
      .updateTable('audit_events')
      // @ts-expect-error: no column of audit_events can be updated
      .set({ outcome: 'failed' })
      .execute()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: '42501' });
  });

  it('refuses them from an application role with every table privilege, purge setting or not', async (ctx) => {
    const allowed = await onDatabase(t.url, (c) =>
      c.query<{ ok: boolean }>(
        'select rolsuper or rolcreaterole as ok from pg_roles where rolname = current_user',
      ),
    );
    if (allowed.rows[0]?.ok !== true) ctx.skip();
    const role = pg.escapeIdentifier(`centcom_t_app_${randomBytes(6).toString('hex')}`);
    // Role names cannot be parameters; this one is ours, and escaped.
    await onDatabase(t.url, (c) => c.query(`create role ${role} nologin`));
    try {
      await onDatabase(t.url, (c) =>
        c.query(`grant select, insert, update, delete, truncate on audit_events to ${role}`),
      );
      const asApp = (statement: string): Promise<unknown> =>
        onDatabase(t.url, async (c) => {
          await c.query('begin');
          try {
            await c.query(`set local role ${role}`);
            await c.query("select set_config('centcom.audit_purge', 'on', true)");
            await c.query(statement);
            return undefined;
          } catch (err) {
            return err;
          } finally {
            await c.query('rollback');
          }
        });
      for (const statement of [
        'delete from audit_events',
        "update audit_events set outcome = 'failed'",
        'truncate audit_events',
      ]) {
        const err = await asApp(statement);
        expect(err, statement).toMatchObject({
          code: '42501',
          message: expect.stringMatching(APPEND_ONLY) as string,
        });
      }
      // The purge function is not the application's to call (EXECUTE is revoked from PUBLIC).
      expect(await asApp('select purge_audit_events(null, now(), 10)')).toMatchObject({
        code: '42501',
        message: expect.stringMatching(
          /permission denied for function purge_audit_events/,
        ) as string,
      });
      // Appending still works for it.
      expect(
        await asApp(
          `insert into audit_events (id, actor_type, actor_id, action, outcome)
           values ('${newId('aud')}', 'system', 'test', 'workspace.update', 'success')`,
        ),
      ).toBeUndefined();
    } finally {
      await onDatabase(t.url, (c) => c.query(`revoke all on audit_events from ${role}`));
      await onDatabase(t.url, (c) => c.query(`drop role ${role}`));
    }
    expect(await outcomes()).toEqual(['success', 'success', 'success']);
  });

  it('purges old events of one workspace, oldest first, up to the limit it is given', async () => {
    const target = await addWorkspace(t.db, t.userId);
    const other = await addWorkspace(t.db, t.userId);
    const now = Date.now();
    let at = now;
    const emitter = createAuditEmitter({ db: t.db, clock: () => at });
    const emitAt = async (daysAgo: number, workspace: string | null): Promise<string> => {
      at = now - daysAgo * DAY_MS;
      return withTransaction(t.db, (trx) =>
        emitter.emit(
          trx,
          workspace === null
            ? event(target, t.userId, { workspaceId: null, target: undefined })
            : event(workspace, t.userId),
        ),
      );
    };
    const old: string[] = [];
    for (const daysAgo of [100, 99, 98, 97, 96]) old.push(await emitAt(daysAgo, target));
    const recent = [await emitAt(10, target), await emitAt(1, target)];
    const others = [await emitAt(100, other)];
    const accountLevel = [await emitAt(100, null), await emitAt(1, null)];

    const cutoff = new Date(now - 30 * DAY_MS);
    const purge = async (workspace: string | null, limit: number): Promise<number> =>
      (
        await sql<{
          purged: number;
        }>`select purge_audit_events(${workspace}, ${cutoff}, ${limit}) as purged`.execute(t.db)
      ).rows[0]?.purged ?? -1;
    const left = async (workspace: string): Promise<string[]> =>
      (
        await t.db
          .selectFrom('audit_events')
          .select('id')
          .where('workspace_id', '=', workspace)
          .orderBy('created_at')
          .execute()
      ).map((r) => r.id);

    expect(await purge(target, 3)).toBe(3);
    expect(await left(target)).toEqual([...old.slice(3), ...recent]);
    expect(await purge(target, 100)).toBe(2);
    expect(await purge(target, 100)).toBe(0);
    expect(await left(target)).toEqual(recent);
    expect(await left(other)).toEqual(others);
    // Events outside any workspace are purged on their own.
    const accountLeft = async (): Promise<string[]> =>
      (
        await t.db
          .selectFrom('audit_events')
          .select('id')
          .where('id', 'in', accountLevel)
          .orderBy('created_at')
          .execute()
      ).map((r) => r.id);
    expect(await purge(null, 100)).toBe(1);
    expect(await accountLeft()).toEqual(accountLevel.slice(1));
  });

  it('closes the way again after a purge, and checks its arguments', async () => {
    const err = await onDatabase(t.url, async (c) => {
      await c.query('begin');
      try {
        await c.query("select purge_audit_events(null, now() - interval '400 days', 10)");
        await c.query('delete from audit_events');
        return undefined;
      } catch (e) {
        return e;
      } finally {
        await c.query('rollback');
      }
    });
    expect(err).toMatchObject({
      code: '42501',
      message: expect.stringMatching(APPEND_ONLY) as string,
    });
    for (const call of [
      'select purge_audit_events(null, null, 10)',
      'select purge_audit_events(null, now(), 0)',
      'select purge_audit_events(null, now(), 10001)',
      'select purge_audit_events(null, now(), null)',
    ]) {
      expect(await failure(call), call).toMatchObject({ code: '22023' });
    }
  });

  it('keeps a workspace with audit events from being deleted', async () => {
    const err = await failure(`delete from workspaces where id = '${workspaceId}'`);
    expect(err).toMatchObject({ code: '23503' });
  });
});

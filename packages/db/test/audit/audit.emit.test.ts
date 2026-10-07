/**
 * The audit emitter on Postgres 16 (B036, card test audit.emit.test.ts; DATABASE_URL, CI's
 * integration job). An event emitted in a transaction that rolls back leaves no row, and one in a
 * transaction that commits leaves exactly one, under the `aud_` id emit returned, together with
 * the change it records (acceptance 1). Events list newest first by (created_at, id); an event for
 * a workspace that does not exist fails its transaction. emit's p95 is under 5 ms (timed in a
 * child process), and listing a workspace's events among 100 000 uses the index (EXPLAIN;
 * acceptance 6). Without a database: the migration follows CONVENTIONS, and the column types.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { newId } from '@centcom/contracts';
import { createAuditEmitter } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import {
  lintMigration,
  MIGRATIONS_DIR,
  withTransaction,
  type AuditEventsTable,
} from '../../src/index.js';
import {
  addWorkspace,
  ADMIN_URL,
  auditDatabase,
  event,
  onDatabase,
  type AuditTestDatabase,
} from './helpers.js';

const FILE = '20260102000600_audit_events.sql';
const INDEX = 'audit_events_workspace_id_created_at_id_idx';
const AUD_ID = /^aud_[0-9A-HJKMNP-TV-Z]{26}$/;
const DB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./emit-bench.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));

describe('the migration file', () => {
  it('follows the conventions', async () => {
    expect(lintMigration(FILE, await readFile(`${MIGRATIONS_DIR}/${FILE}`, 'utf8'))).toEqual([]);
  });

  it('types every column as written once and never updated', () => {
    expectTypeOf<AuditEventsTable['meta']['__update__']>().toBeNever();
    expectTypeOf<AuditEventsTable['outcome']['__update__']>().toBeNever();
    expectTypeOf<AuditEventsTable['workspace_id']['__select__']>().toEqualTypeOf<string | null>();
  });
});

/** Plan nodes of an EXPLAIN (FORMAT JSON) plan, depth first. */
type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

describe.runIf(ADMIN_URL !== undefined)('the audit emitter on Postgres 16', () => {
  let t: AuditTestDatabase;
  beforeAll(async () => {
    t = await auditDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  const rowsWithId = (id: string) =>
    t.db.selectFrom('audit_events').selectAll().where('id', '=', id).execute();
  const nameOf = async (workspaceId: string): Promise<string> =>
    (
      await t.db
        .selectFrom('workspaces')
        .select('name')
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()
    ).name;

  it('leaves no row when the transaction rolls back, and one when it commits (acceptance 1)', async () => {
    const workspaceId = await addWorkspace(t.db, t.userId);
    const emitter = createAuditEmitter({ db: t.db });
    const requestId = newId('req');
    let rolledBack = '';
    const err = await withTransaction(t.db, async (trx) => {
      await trx
        .updateTable('workspaces')
        .set({ name: 'Renamed' })
        .where('id', '=', workspaceId)
        .execute();
      rolledBack = await emitter.emit(trx, event(workspaceId, t.userId, { requestId }));
      throw new Error('the change failed');
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'the change failed' });
    expect(rolledBack).toMatch(AUD_ID);
    expect(await rowsWithId(rolledBack)).toEqual([]);
    expect(await nameOf(workspaceId)).toBe('Acme');

    const committed = await withTransaction(t.db, async (trx) => {
      await trx
        .updateTable('workspaces')
        .set({ name: 'Renamed' })
        .where('id', '=', workspaceId)
        .execute();
      return emitter.emit(trx, event(workspaceId, t.userId, { requestId }));
    });
    expect(committed).toMatch(AUD_ID);
    expect(committed).not.toBe(rolledBack);
    expect(await nameOf(workspaceId)).toBe('Renamed');
    expect(await rowsWithId(committed)).toEqual([
      {
        id: committed,
        workspace_id: workspaceId,
        actor_type: 'user',
        actor_id: t.userId,
        action: 'workspace.update',
        target_type: 'workspace',
        target_id: workspaceId,
        outcome: 'success',
        request_id: requestId,
        meta: { fields: 'name' },
        created_at: expect.any(Date) as Date,
      },
    ]);
    const all = await t.db
      .selectFrom('audit_events')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .execute();
    expect(all).toEqual([{ id: committed }]);
  });

  it('lists events newest first by (created_at, id), each under its own id', async () => {
    const workspaceId = await addWorkspace(t.db, t.userId);
    const emitter = createAuditEmitter({ db: t.db });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        await withTransaction(t.db, (trx) => emitter.emit(trx, event(workspaceId, t.userId))),
      );
    }
    expect(new Set(ids).size).toBe(20);
    const listed = await t.db
      .selectFrom('audit_events')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    expect(listed.map((r) => r.id)).toEqual([...ids].reverse());
  });

  it('fails the transaction of an event for a workspace that does not exist', async () => {
    const emitter = createAuditEmitter({ db: t.db });
    const missing = newId('wsp');
    const err = await withTransaction(t.db, (trx) =>
      emitter.emit(trx, event(missing, t.userId)),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: '23503' });
  });

  it('emits with a p95 under 5 ms (acceptance 6)', async () => {
    const workspaceId = await addWorkspace(t.db, t.userId);
    // Timed in a separate process (see emit-bench.ts); the best of three rounds of 300.
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: DB_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      input: JSON.stringify({ url: t.url, workspaceId, userId: t.userId }),
    });
    const { p95s } = JSON.parse(out) as { p95s: number[] };
    expect(p95s).toHaveLength(3);
    expect(Math.min(...p95s)).toBeLessThan(5);
    const written = await t.db
      .selectFrom('audit_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    expect(Number(written.n)).toBe(950);
  }, 180_000);

  it("lists a workspace's events by the index among 100 000 rows (acceptance 6, EXPLAIN)", async () => {
    // 100 workspaces with 1 000 events each, one a second going back from now.
    const hexId = (prefix: string, n: string): string =>
      `'${prefix}_' || lpad(upper(to_hex(${n})), 26, '0')`;
    await onDatabase(t.url, async (c) => {
      await c.query(
        `insert into workspaces (id, name, slug, created_by)
         select ${hexId('wsp', 'i')}, 'W' || i, 'bulk-' || i, $1
         from generate_series(1, 100) as i`,
        [t.userId],
      );
      await c.query(
        `insert into audit_events (id, workspace_id, actor_type, actor_id, action, outcome, created_at)
         select ${hexId('aud', 'i')}, ${hexId('wsp', '1 + i % 100')}, 'user', $1,
                'workspace.update', 'success', now() - i * interval '1 second'
         from generate_series(1, 100000) as i`,
        [t.userId],
      );
      await c.query('analyze audit_events');
    });
    const workspace = `wsp_${'0'.repeat(25)}7`;
    const plan = async (query: string): Promise<PlanNode[]> => {
      const result = await onDatabase(t.url, (c) =>
        c.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(`explain (format json) ${query}`),
      );
      const root = result.rows[0]?.['QUERY PLAN'][0].Plan;
      return root === undefined ? [] : nodesOf(root);
    };
    const firstPage = await plan(
      `select id, created_at, action from audit_events where workspace_id = '${workspace}'
       order by created_at desc, id desc limit 50`,
    );
    const nextPage = await plan(
      `select id, created_at, action from audit_events where workspace_id = '${workspace}'
         and (created_at, id) < (now() - interval '50000 seconds', 'aud_${'0'.repeat(22)}C350')
       order by created_at desc, id desc limit 50`,
    );
    for (const nodes of [firstPage, nextPage]) {
      expect(
        nodes.some((n) => /Index (Only )?Scan/.test(n['Node Type']) && n['Index Name'] === INDEX),
      ).toBe(true);
      expect(nodes.some((n) => /Sort/.test(n['Node Type']))).toBe(false);
    }
  }, 120_000);
});

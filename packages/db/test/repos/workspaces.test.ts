/**
 * The workspace store on Postgres 16 (B027; DATABASE_URL, CI's integration job), in a throwaway
 * database with every migration: a create inserts the workspace and its owner in one transaction,
 * and a taken slug inserts nothing without spoiling the transaction; one owner per workspace (the
 * partial unique index); reads see live workspaces only, with the member's role, the owner and the
 * member count; members' lists page newest first by keyset; an update waits for the row lock and
 * sees the version the other transaction wrote; and a purge removes a deleted workspace's audit
 * events, sessions, memberships and row (never a live one; a second purge does nothing). Without
 * a database: the migration follows CONVENTIONS.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '@centcom/contracts';
import { createAuditEmitter, Secret, type SigningKeys } from '@centcom/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createWorkspaceStore,
  lintMigration,
  migrate,
  MIGRATIONS_DIR,
  withTransaction,
  type AuditDatabase,
  type CoreDatabase,
  type WorkspaceStore,
} from '../../src/index.js';
import { ADMIN_URL, onDatabase, tempDatabase } from '../runner/helpers.js';

const FILE = '20260102000700_workspaces_crud.sql';
const KEYS: SigningKeys = [{ id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) }];

describe('the migration file', () => {
  it('follows the conventions', async () => {
    expect(lintMigration(FILE, await readFile(`${MIGRATIONS_DIR}/${FILE}`, 'utf8'))).toEqual([]);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the workspace store on Postgres 16', () => {
  let db: Kysely<CoreDatabase & AuditDatabase>;
  let url: string;
  let drop: () => Promise<void>;
  let store: WorkspaceStore;
  beforeAll(async () => {
    ({ url, drop } = await tempDatabase());
    db = createDb<CoreDatabase & AuditDatabase>({ url });
    await migrate(db, MIGRATIONS_DIR);
    store = createWorkspaceStore(db);
  }, 60_000);
  afterAll(async () => {
    await closeDb(db);
    await drop();
  });

  const addUser = async (): Promise<string> => {
    const id = newId('usr');
    await db
      .insertInto('users')
      .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Ada' })
      .execute();
    return id;
  };
  const slugBase = (): string => `ws-${randomBytes(4).toString('hex')}`;
  /** Creates a workspace owned by `owner` through the store. */
  const create = async (owner: string, slug = slugBase()): Promise<string> => {
    const id = newId('wsp');
    const record = await store.transaction((tx) =>
      tx.insert({ id, name: 'Acme', slug, ownerId: owner, membershipId: newId('mem') }),
    );
    expect(record).not.toBeNull();
    return id;
  };
  const failure = (statement: string): Promise<unknown> =>
    onDatabase(url, (c) => c.query(statement)).then(
      () => undefined,
      (err: unknown) => err,
    );

  it('creates a workspace and its owner together; a taken slug inserts nothing', async () => {
    const owner = await addUser();
    const base = slugBase();
    const id = newId('wsp');
    const record = await store.transaction(async (tx) => {
      expect(await tx.lockUser(owner)).toBe(true);
      expect(await tx.lockUser(newId('usr'))).toBe(false);
      expect(await tx.countOwned(owner)).toBe(0);
      return tx.insert({
        id,
        name: 'Acme',
        slug: base,
        ownerId: owner,
        membershipId: newId('mem'),
      });
    });
    expect(record).toMatchObject({ id, name: 'Acme', slug: base, version: 1 });
    expect(record?.createdAt).toBeInstanceOf(Date);
    await store.transaction(async (tx) => {
      const taken = await tx.insert({
        id: newId('wsp'),
        name: 'Other',
        slug: base,
        ownerId: owner,
        membershipId: newId('mem'),
      });
      expect(taken).toBeNull();
      // The transaction is still usable for the next candidate.
      expect(await tx.slugsLike(base)).toEqual([base]);
      const next = await tx.insert({
        id: newId('wsp'),
        name: 'Other',
        slug: `${base}-2`,
        ownerId: owner,
        membershipId: newId('mem'),
      });
      expect(next?.slug).toBe(`${base}-2`);
      expect((await tx.slugsLike(base)).sort()).toEqual([base, `${base}-2`]);
      expect(await tx.countOwned(owner)).toBe(2);
    });
    const owners = await db
      .selectFrom('memberships')
      .select(['user_id', 'role'])
      .where('workspace_id', '=', id)
      .execute();
    expect(owners).toEqual([{ user_id: owner, role: 'owner' }]);
  });

  it('keeps one owner per workspace (the partial unique index)', async () => {
    const owner = await addUser();
    const other = await addUser();
    const id = await create(owner);
    const insert = (role: string) =>
      failure(
        `insert into memberships (id, workspace_id, user_id, role)
         values ('${newId('mem')}', '${id}', '${other}', '${role}')`,
      );
    expect(await insert('owner')).toMatchObject({
      code: '23505',
      constraint: 'memberships_workspace_id_owner_key',
    });
    expect(await insert('admin')).toBeUndefined();
  });

  it("reads live workspaces only, with the member's role, the owner and the member count", async () => {
    const owner = await addUser();
    const member = await addUser();
    const stranger = await addUser();
    const id = await create(owner);
    await db
      .insertInto('memberships')
      .values({ id: newId('mem'), workspace_id: id, user_id: member, role: 'member' })
      .execute();
    expect(await store.findForMember(id, owner)).toMatchObject({
      id,
      role: 'owner',
      ownerId: owner,
      memberCount: 2,
      version: 1,
    });
    expect((await store.findForMember(id, member))?.role).toBe('member');
    expect(await store.findForMember(id, stranger)).toBeNull();
    expect(await store.findLive(id)).toMatchObject({ id, role: null, ownerId: owner });
    await store.transaction((tx) => tx.softDelete(id));
    expect(await store.findForMember(id, owner)).toBeNull();
    expect(await store.findLive(id)).toBeNull();
    const page = await store.listForMember(owner, {
      limit: 10,
      sort: 'created',
      filterHash: 'f',
      keys: KEYS,
      now: Date.now(),
    });
    expect(page.data.map((w) => w.id)).not.toContain(id);
  });

  it("pages a member's workspaces newest first by keyset", async () => {
    const owner = await addUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await create(owner));
    const params = { sort: 'created', filterHash: 'f', keys: KEYS, now: Date.now() };
    const first = await store.listForMember(owner, { ...params, limit: 2 });
    const second = await store.listForMember(owner, {
      ...params,
      limit: 2,
      cursor: first.next_cursor ?? '',
    });
    const third = await store.listForMember(owner, {
      ...params,
      limit: 2,
      cursor: second.next_cursor ?? '',
    });
    expect([...first.data, ...second.data, ...third.data].map((w) => w.id)).toEqual(
      [...ids].reverse(),
    );
    expect(third.next_cursor).toBeNull();
    expect(first.data[0]).toMatchObject({ role: 'owner', memberCount: 1 });
  });

  it('makes an update wait for the row lock, then see the version written before it', async () => {
    const owner = await addUser();
    const id = await create(owner);
    const first = store.transaction(async (tx) => {
      expect((await tx.lockLive(id))?.version).toBe(1);
      await sleep(300);
      return tx.update(id, { name: 'First' });
    });
    await sleep(100);
    const second = store.transaction(async (tx) => (await tx.lockLive(id))?.version);
    const [updated, seen] = await Promise.all([first, second]);
    expect(updated).toMatchObject({ name: 'First', version: 2 });
    expect(seen).toBe(2);
  });

  it('purges a deleted workspace and everything that references it, never a live one', async () => {
    const owner = await addUser();
    const id = await create(owner);
    const devices = await db
      .insertInto('devices')
      .values({
        id: newId('dev'),
        user_id: owner,
        name: 'Laptop',
        platform: 'linux',
        x25519_pub: randomBytes(32).toString('base64url'),
        ed25519_pub: randomBytes(32).toString('base64url'),
        fingerprint: 'ABCD-EFGH-IJKL',
      })
      .returning('id')
      .execute();
    const sessionId = newId('ses');
    await db
      .insertInto('sessions')
      .values({ id: sessionId, workspace_id: id, name: 'S', region: 'eu', created_by: owner })
      .execute();
    await db
      .insertInto('session_members')
      .values({
        id: newId('mem'),
        session_id: sessionId,
        user_id: owner,
        device_id: devices[0]?.id ?? '',
        role: 'host',
        slot: 0,
      })
      .execute();
    const emitter = createAuditEmitter({ db });
    for (let i = 0; i < 3; i++) {
      await withTransaction(db, (trx) =>
        emitter.emit(trx, {
          workspaceId: id,
          actor: { type: 'user', id: owner },
          action: 'workspace.update',
          outcome: 'success',
        }),
      );
    }
    const accountLevel = await withTransaction(db, (trx) =>
      emitter.emit(trx, {
        workspaceId: null,
        actor: { type: 'user', id: owner },
        action: 'workspace.delete',
        target: { type: 'workspace', id },
        outcome: 'success',
      }),
    );
    await expect(store.purge(id)).rejects.toThrow(/live/);
    await store.transaction((tx) => tx.softDelete(id));
    expect(await store.purge(id)).toEqual({ purged: true });
    const count = async (table: string, column: string, value: string): Promise<number> =>
      Number(
        (
          await onDatabase(url, (c) =>
            c.query<{ n: string }>(`select count(*) as n from ${table} where ${column} = $1`, [
              value,
            ]),
          )
        ).rows[0]?.n,
      );
    expect(await count('workspaces', 'id', id)).toBe(0);
    expect(await count('memberships', 'workspace_id', id)).toBe(0);
    expect(await count('sessions', 'workspace_id', id)).toBe(0);
    expect(await count('session_members', 'session_id', sessionId)).toBe(0);
    expect(await count('audit_events', 'workspace_id', id)).toBe(0);
    // The account-level record of the deletion stays.
    expect(await count('audit_events', 'id', accountLevel)).toBe(1);
    expect(await store.purge(id)).toEqual({ purged: false });
  });
});

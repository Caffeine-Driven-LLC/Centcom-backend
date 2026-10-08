/**
 * The project store on Postgres 16 (B035; DATABASE_URL, CI's integration job), in a throwaway
 * database with every migration: one name per workspace ignoring case (the same name in two
 * workspaces is fine), concurrent creates of one name giving one project, renames into a taken
 * name refused without a raw unique violation; versions moved on by every change; projects of a
 * deleted workspace hidden from every read and lock; projects by keyset, oldest first; the
 * table's checks; and a purged workspace's projects deleted by the purge hook, without which
 * B027's purge is refused.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { Secret, type SigningKeys } from '@centcom/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createProjectStore,
  createWorkspaceStore,
  migrate,
  MIGRATIONS_DIR,
  type NewProject,
  type ProjectDatabase,
  type ProjectRecord,
  type ProjectStore,
} from '../../src/index.js';
import { ADMIN_URL, tempDatabase } from '../runner/helpers.js';

const KEYS: SigningKeys = [{ id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) }];

describe.runIf(ADMIN_URL !== undefined)('the project store on Postgres 16', () => {
  let db: Kysely<ProjectDatabase>;
  let drop: () => Promise<void>;
  let projects: ProjectStore;
  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await tempDatabase());
    db = createDb<ProjectDatabase>({ url });
    await migrate(db, MIGRATIONS_DIR);
    projects = createProjectStore(db);
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
  const workspace = async (owner: string): Promise<string> => {
    const id = newId('wsp');
    await createWorkspaceStore(db).transaction((tx) =>
      tx.insert({
        id,
        name: 'Acme',
        slug: `ws-${randomBytes(4).toString('hex')}`,
        ownerId: owner,
        membershipId: newId('mem'),
      }),
    );
    return id;
  };
  const draft = (
    workspaceId: string,
    createdBy: string,
    over: Partial<NewProject> = {},
  ): NewProject => ({
    id: newId('prj'),
    workspaceId,
    name: `Project ${randomBytes(3).toString('hex')}`,
    repoRef: null,
    createdBy,
    ...over,
  });
  /** Inserts; throws when the store wrote nothing. */
  const insert = async (input: NewProject): Promise<ProjectRecord> => {
    const row = await projects.transaction((tx) => tx.insert(input));
    if (row === null) throw new Error('insert: nothing written');
    return row;
  };

  it('keeps one name per workspace ignoring case, and the same name in another workspace', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const other = await workspace(owner);
    const created = await insert(
      draft(wsp, owner, { name: 'Api', repoRef: 'github.com/acme/api' }),
    );
    expect(created).toMatchObject({
      workspaceId: wsp,
      name: 'Api',
      repoRef: 'github.com/acme/api',
      createdBy: owner,
      version: 1,
    });
    expect(await projects.transaction((tx) => tx.insert(draft(wsp, owner, { name: 'api' })))).toBe(
      null,
    );
    expect((await insert(draft(other, owner, { name: 'api' }))).workspaceId).toBe(other);
    const names = await db
      .selectFrom('projects')
      .select('name')
      .where('workspace_id', '=', wsp)
      .execute();
    expect(names).toEqual([{ name: 'Api' }]);
  });

  it('gives one project to concurrent creates of one name', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        projects.transaction((tx) =>
          tx.insert(draft(wsp, owner, { name: i % 2 === 0 ? 'Web' : 'WEB' })),
        ),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const count = await db
      .selectFrom('projects')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', wsp)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('updates under a lock, moving the version on, and refuses a taken name', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const api = await insert(draft(wsp, owner, { name: 'Api' }));
    await insert(draft(wsp, owner, { name: 'Web' }));
    const renamed = await projects.transaction(async (tx) => {
      expect(await tx.lockById(api.id)).toMatchObject({ id: api.id, version: 1 });
      return tx.update(api.id, { name: 'Gateway', repoRef: 'sha256:ab12' });
    });
    expect(renamed).toMatchObject({ name: 'Gateway', repoRef: 'sha256:ab12', version: 2 });
    expect(renamed?.updatedAt.getTime()).toBeGreaterThanOrEqual(api.updatedAt.getTime());
    const cleared = await projects.transaction((tx) => tx.update(api.id, { repoRef: null }));
    expect(cleared).toMatchObject({ name: 'Gateway', repoRef: null, version: 3 });
    // A taken name, in another case: null, and nothing changed.
    expect(await projects.transaction((tx) => tx.update(api.id, { name: 'web' }))).toBeNull();
    expect(await projects.findById(api.id)).toMatchObject({ name: 'Gateway', version: 3 });
    // Its own name in another case is not a conflict.
    expect(
      await projects.transaction((tx) => tx.update(api.id, { name: 'GATEWAY' })),
    ).toMatchObject({ name: 'GATEWAY', version: 4 });
  });

  it('deletes a project', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const p = await insert(draft(wsp, owner));
    await projects.transaction((tx) => tx.delete(p.id));
    expect(await projects.findById(p.id)).toBeNull();
  });

  it('hides the projects of a deleted workspace from every read and lock', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const p = await insert(draft(wsp, owner));
    expect(await projects.transaction((tx) => tx.lockLiveWorkspace(wsp))).toBe(true);
    expect(await projects.transaction((tx) => tx.lockLiveWorkspace(newId('wsp')))).toBe(false);
    await createWorkspaceStore(db).transaction((tx) => tx.softDelete(wsp));
    expect(await projects.findById(p.id)).toBeNull();
    expect(await projects.transaction((tx) => tx.lockById(p.id))).toBeNull();
    expect(await projects.transaction((tx) => tx.lockLiveWorkspace(wsp))).toBe(false);
    const page = await projects.list(wsp, {
      sort: 'created',
      filterHash: 'f',
      keys: KEYS,
      now: Date.now(),
      limit: 50,
    });
    expect(page.data).toEqual([]);
  });

  it('lists a workspace’s projects oldest first by keyset', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const other = await workspace(owner);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await insert(draft(wsp, owner))).id);
    await insert(draft(other, owner));
    const params = { sort: 'created', filterHash: 'f', keys: KEYS, now: Date.now(), limit: 2 };
    const seen: string[] = [];
    const more: boolean[] = [];
    let cursor: string | undefined;
    do {
      const page = await projects.list(wsp, {
        ...params,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.data.map((p) => p.id));
      more.push(page.has_more);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(ids);
    expect(more).toEqual([true, true, false]);
  });

  it('refuses rows the checks forbid', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    await expect(insert(draft(wsp, owner, { id: 'prj_bad' }))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(draft(wsp, owner, { name: '' }))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(draft(wsp, owner, { name: 'x'.repeat(61) }))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(draft(wsp, owner, { repoRef: 'r'.repeat(129) }))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(draft(newId('wsp'), owner))).rejects.toMatchObject({ code: '23503' });
  });

  it('deletes a purged workspace’s projects (never a live one’s), which B027’s purge needs', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    await insert(draft(wsp, owner));
    await insert(draft(wsp, owner));
    const workspaces = createWorkspaceStore(db);
    expect(await projects.deleteForWorkspace(wsp)).toBe(0);
    await workspaces.transaction((tx) => tx.softDelete(wsp));
    // The foreign key restricts: the purge is refused while projects remain.
    await expect(workspaces.purge(wsp)).rejects.toMatchObject({ code: '23503' });
    expect(await projects.deleteForWorkspace(wsp)).toBe(2);
    expect(await workspaces.purge(wsp)).toEqual({ purged: true });
    expect(await projects.deleteForWorkspace(wsp)).toBe(0);
  });
});

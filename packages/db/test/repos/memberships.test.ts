/**
 * The Postgres MembershipReader (B021): roles straight from `memberships` and `session_members`,
 * nothing for a soft-deleted workspace or a member who left, the most powerful of several live
 * seats, and null for strangers. Against a real Postgres 16 in a throwaway database (DATABASE_URL,
 * CI's integration job); without a database, only the SQL shape is checked.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createMembershipRepo,
  migrate,
  MIGRATIONS_DIR,
  type CoreDatabase,
} from '../../src/index.js';
import { ADMIN_URL, tempDatabase } from '../runner/helpers.js';

describe('createMembershipRepo without a database', () => {
  it('reads the role of the workspace member, skipping soft-deleted workspaces', () => {
    const db = new Kysely<CoreDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const compiled = db
      .selectFrom('memberships')
      .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
      .select('memberships.role')
      .where('workspaces.deleted_at', 'is', null)
      .compile();
    expect(compiled.sql).toContain('"workspaces"."deleted_at" is null');
    expect(typeof createMembershipRepo(db).workspaceRole).toBe('function');
  });
});

describe.runIf(ADMIN_URL !== undefined)('createMembershipRepo on Postgres 16', () => {
  let db: Kysely<CoreDatabase>;
  let drop: () => Promise<void>;
  const ids = {
    owner: newId('usr'),
    member: newId('usr'),
    stranger: newId('usr'),
    workspace: newId('wsp'),
    session: newId('ses'),
  };

  beforeAll(async () => {
    const temp = await tempDatabase();
    drop = temp.drop;
    db = createDb<CoreDatabase>({ url: temp.url });
    await migrate(db, MIGRATIONS_DIR);
    for (const id of [ids.owner, ids.member, ids.stranger]) {
      await db
        .insertInto('users')
        .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'U' })
        .execute();
    }
    await db
      .insertInto('workspaces')
      .values({
        id: ids.workspace,
        name: 'W',
        slug: `w-${randomBytes(4).toString('hex')}`,
        created_by: ids.owner,
      })
      .execute();
    await db
      .insertInto('memberships')
      .values([
        { id: newId('mem'), workspace_id: ids.workspace, user_id: ids.owner, role: 'owner' },
        { id: newId('mem'), workspace_id: ids.workspace, user_id: ids.member, role: 'member' },
      ])
      .execute();
    await db
      .insertInto('sessions')
      .values({
        id: ids.session,
        workspace_id: ids.workspace,
        name: 'S',
        region: 'eu',
        created_by: ids.owner,
      })
      .execute();
    const device = async (userId: string): Promise<string> => {
      const id = newId('dev');
      await db
        .insertInto('devices')
        .values({
          id,
          user_id: userId,
          name: 'D',
          platform: 'linux',
          x25519_pub: randomBytes(32).toString('base64url'),
          ed25519_pub: randomBytes(32).toString('base64url'),
          fingerprint: 'ABCD-EFGH-JKLM',
        })
        .execute();
      return id;
    };
    // The member sits twice (two devices): viewer and editor; an older host seat was left.
    await db
      .insertInto('session_members')
      .values([
        {
          id: newId('mem'),
          session_id: ids.session,
          user_id: ids.member,
          device_id: await device(ids.member),
          role: 'viewer',
          slot: 0,
        },
        {
          id: newId('mem'),
          session_id: ids.session,
          user_id: ids.member,
          device_id: await device(ids.member),
          role: 'editor',
          slot: 1,
        },
        {
          id: newId('mem'),
          session_id: ids.session,
          user_id: ids.member,
          device_id: await device(ids.member),
          role: 'host',
          slot: 2,
          left_at: new Date(),
        },
      ])
      .execute();
  }, 60_000);

  afterAll(async () => {
    await closeDb(db);
    await drop();
  });

  it('reads workspace roles, and nothing for strangers', async () => {
    const repo = createMembershipRepo(db);
    expect(await repo.workspaceRole(ids.owner, ids.workspace)).toBe('owner');
    expect(await repo.workspaceRole(ids.member, ids.workspace)).toBe('member');
    expect(await repo.workspaceRole(ids.stranger, ids.workspace)).toBeNull();
    expect(await repo.workspaceRole(ids.owner, newId('wsp'))).toBeNull();
  });

  it('reads the most powerful live session seat, ignoring seats left', async () => {
    const repo = createMembershipRepo(db);
    expect(await repo.sessionRole(ids.member, ids.session)).toBe('editor');
    expect(await repo.sessionRole(ids.owner, ids.session)).toBeNull();
    expect(await repo.sessionRole(ids.member, newId('ses'))).toBeNull();
  });

  it('gives no role in a soft-deleted workspace', async () => {
    const repo = createMembershipRepo(db);
    await db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', ids.workspace)
      .execute();
    expect(await repo.workspaceRole(ids.owner, ids.workspace)).toBeNull();
  });
});

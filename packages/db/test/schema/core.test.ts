/**
 * Core schema v1 (B008). Without a database: the migration follows CONVENTIONS, and tsc checks a
 * sample query plus a column map tied to the Kysely interfaces (acceptance 7, type side). Against a
 * real Postgres 16 (DATABASE_URL set, CI's integration job), in a throwaway database: B007's runner
 * creates exactly the six tables and a second run is a no-op (acceptance 1); the constraint matrix
 * (acceptance 2-6); the column map matches information_schema (acceptance 7, database side); and a
 * role that may not create citext gets a clear failure.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, type Api } from '@centcom/contracts';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type Insertable,
  type Selectable,
  type Updateable,
} from 'kysely';
import pg from 'pg';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  closeDb,
  createDb,
  lintMigration,
  migrate,
  MIGRATIONS_DIR,
  type CoreDatabase,
  type UsersTable,
} from '../../src/index.js';
import { ADMIN_URL, onDatabase, tempDatabase } from '../runner/helpers.js';

const FILE = '20260101000000_core_schema.sql';
/** This file's version: the tests stop the runner here, so later lanes' migrations (B017 on) do not change them. */
const CORE_VERSION = '20260101000000';
const TABLES = ['devices', 'memberships', 'session_members', 'sessions', 'users', 'workspaces'];

type Udt = 'text' | 'citext' | 'timestamptz' | 'bool' | 'int4' | 'jsonb';
/** For each column of a table type: whether it can be null (from the type), and its Postgres type. */
type Spec<T> = {
  [K in keyof Selectable<T>]-?: {
    nullable: null extends Selectable<T>[K] ? true : false;
    udt: Udt;
  };
};

/**
 * Every column of the core tables. `satisfies` makes tsc check it against the interfaces: a
 * missing or extra column, or a nullability that differs from the type, fails the typecheck. The
 * Postgres test then compares it with information_schema, so interfaces and database agree.
 */
const CORE_COLUMNS = {
  users: {
    id: { nullable: false, udt: 'text' },
    email: { nullable: false, udt: 'citext' },
    display_name: { nullable: false, udt: 'text' },
    locale: { nullable: false, udt: 'text' },
    avatar_slot: { nullable: true, udt: 'text' },
    telemetry_opt_in: { nullable: false, udt: 'bool' },
    status: { nullable: false, udt: 'text' },
    deletion_requested_at: { nullable: true, udt: 'timestamptz' },
    created_at: { nullable: false, udt: 'timestamptz' },
    updated_at: { nullable: false, udt: 'timestamptz' },
  },
  devices: {
    id: { nullable: false, udt: 'text' },
    user_id: { nullable: false, udt: 'text' },
    name: { nullable: false, udt: 'text' },
    platform: { nullable: false, udt: 'text' },
    x25519_pub: { nullable: false, udt: 'text' },
    ed25519_pub: { nullable: false, udt: 'text' },
    fingerprint: { nullable: false, udt: 'text' },
    last_seen_at: { nullable: true, udt: 'timestamptz' },
    revoked_at: { nullable: true, udt: 'timestamptz' },
    created_at: { nullable: false, udt: 'timestamptz' },
  },
  workspaces: {
    id: { nullable: false, udt: 'text' },
    name: { nullable: false, udt: 'text' },
    slug: { nullable: false, udt: 'text' },
    settings: { nullable: false, udt: 'jsonb' },
    version: { nullable: false, udt: 'int4' },
    created_by: { nullable: false, udt: 'text' },
    created_at: { nullable: false, udt: 'timestamptz' },
    updated_at: { nullable: false, udt: 'timestamptz' },
    deleted_at: { nullable: true, udt: 'timestamptz' },
  },
  memberships: {
    id: { nullable: false, udt: 'text' },
    workspace_id: { nullable: false, udt: 'text' },
    user_id: { nullable: false, udt: 'text' },
    role: { nullable: false, udt: 'text' },
    created_at: { nullable: false, udt: 'timestamptz' },
  },
  sessions: {
    id: { nullable: false, udt: 'text' },
    workspace_id: { nullable: true, udt: 'text' },
    name: { nullable: false, udt: 'text' },
    state: { nullable: false, udt: 'text' },
    region: { nullable: false, udt: 'text' },
    created_by: { nullable: false, udt: 'text' },
    created_at: { nullable: false, udt: 'timestamptz' },
    ended_at: { nullable: true, udt: 'timestamptz' },
  },
  session_members: {
    id: { nullable: false, udt: 'text' },
    session_id: { nullable: false, udt: 'text' },
    user_id: { nullable: false, udt: 'text' },
    device_id: { nullable: false, udt: 'text' },
    role: { nullable: false, udt: 'text' },
    slot: { nullable: false, udt: 'int4' },
    joined_at: { nullable: false, udt: 'timestamptz' },
    left_at: { nullable: true, udt: 'timestamptz' },
  },
} as const satisfies { [T in keyof CoreDatabase]: Spec<CoreDatabase[T]> };

/** Keys a type requires (not optional). */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

/** A Kysely instance that only compiles queries (no database). */
const compileOnly = new Kysely<CoreDatabase>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('the migration file', () => {
  it('follows the conventions: rollback note, nothing destructive, no transaction control', async () => {
    const text = await readFile(join(MIGRATIONS_DIR, FILE), 'utf8');
    expect(lintMigration(FILE, text)).toEqual([]);
  });
});

describe('Kysely types (acceptance 7, type side)', () => {
  it('cover every table of the migration', () => {
    expect(Object.keys(CORE_COLUMNS).sort()).toEqual(TABLES);
  });

  it('type a sample query against CoreDatabase', () => {
    const workspaceId = newId('wsp');
    const query = compileOnly
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select(['users.email', 'users.display_name', 'memberships.role'])
      .where('memberships.workspace_id', '=', workspaceId)
      .orderBy('users.display_name');
    expectTypeOf<Awaited<ReturnType<typeof query.execute>>>().toEqualTypeOf<
      { email: string; display_name: string; role: Api.Role }[]
    >();
    const compiled = query.compile();
    expect(compiled.sql).toContain('inner join "users" on "users"."id" = "memberships"."user_id"');
    expect(compiled.parameters).toEqual([workspaceId]);
  });

  it('make database defaults optional on insert, and keys and creation times fixed', () => {
    expectTypeOf<RequiredKeys<Insertable<UsersTable>>>().toEqualTypeOf<
      'id' | 'email' | 'display_name'
    >();
    expectTypeOf<RequiredKeys<Insertable<CoreDatabase['sessions']>>>().toEqualTypeOf<
      'id' | 'name' | 'region' | 'created_by'
    >();
    expectTypeOf<keyof Updateable<UsersTable>>().toEqualTypeOf<
      | 'email'
      | 'display_name'
      | 'locale'
      | 'avatar_slot'
      | 'telemetry_opt_in'
      | 'status'
      | 'deletion_requested_at'
      | 'updated_at'
    >();
    expectTypeOf<
      Selectable<CoreDatabase['session_members']>['role']
    >().toEqualTypeOf<Api.SessionRole>();
    expectTypeOf<Selectable<CoreDatabase['sessions']>['state']>().toEqualTypeOf<
      Api.Session['state']
    >();
    expectTypeOf<Selectable<CoreDatabase['devices']>['platform']>().toEqualTypeOf<
      Api.Device['platform']
    >();
  });
});

/** A 32-byte public key, base64url without padding (43 characters). */
const publicKey = (): string => randomBytes(32).toString('base64url');

describe.runIf(ADMIN_URL !== undefined)('core schema on Postgres 16', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** A throwaway database with the core schema applied by B007's runner. */
  async function migrated(): Promise<{ url: string; db: Kysely<CoreDatabase> }> {
    const { url, drop } = await tempDatabase();
    const db = createDb<CoreDatabase>({ url });
    cleanups.push(drop, () => closeDb(db));
    await migrate(db, MIGRATIONS_DIR, { target: CORE_VERSION });
    return { url, db };
  }

  /** Rows that satisfy every constraint, to build the failing cases from. */
  const user = (overrides: Partial<Insertable<UsersTable>> = {}): Insertable<UsersTable> => ({
    id: newId('usr'),
    email: `${randomBytes(4).toString('hex')}@example.com`,
    display_name: 'Ada',
    ...overrides,
  });

  async function seed(db: Kysely<CoreDatabase>): Promise<{
    userId: string;
    deviceId: string;
    workspaceId: string;
    sessionId: string;
  }> {
    const userId = newId('usr');
    const deviceId = newId('dev');
    const workspaceId = newId('wsp');
    const sessionId = newId('ses');
    await db
      .insertInto('users')
      .values(user({ id: userId }))
      .execute();
    await db
      .insertInto('devices')
      .values({
        id: deviceId,
        user_id: userId,
        name: 'laptop',
        platform: 'linux',
        x25519_pub: publicKey(),
        ed25519_pub: publicKey(),
        fingerprint: 'ABCD-EFGH-IJKL',
      })
      .execute();
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, name: 'Acme', slug: 'acme', created_by: userId })
      .execute();
    await db
      .insertInto('sessions')
      .values({
        id: sessionId,
        workspace_id: workspaceId,
        name: 'Fix login',
        region: 'eu',
        created_by: userId,
      })
      .execute();
    return { userId, deviceId, workspaceId, sessionId };
  }

  /** The SQLSTATE a statement fails with, or 'ok'. */
  const outcome = (run: Promise<unknown>): Promise<string> =>
    run.then(
      () => 'ok',
      (err: unknown) => String((err as { code?: unknown }).code ?? err),
    );

  const CHECK = '23514';
  const UNIQUE = '23505';
  const FOREIGN_KEY = '23503';

  it('creates exactly the six tables, and a second run applies nothing (acceptance 1)', async () => {
    const { url, db } = await migrated();
    const snapshot = (): Promise<unknown[]> =>
      onDatabase(
        url,
        async (c) =>
          (
            await c.query(
              `select table_name, column_name, data_type, is_nullable, column_default
               from information_schema.columns where table_schema = 'public' order by 1, 2`,
            )
          ).rows,
      );
    const tables = await onDatabase(url, async (c) =>
      (
        await c.query<{ name: string }>(
          "select tablename as name from pg_tables where schemaname = 'public' order by 1",
        )
      ).rows.map((r) => r.name),
    );
    expect(tables).toEqual([...TABLES, 'schema_migrations'].sort());
    const before = await snapshot();
    expect(await migrate(db, MIGRATIONS_DIR, { target: CORE_VERSION })).toEqual({ applied: [] });
    expect(await snapshot()).toEqual(before);
  });

  it('matches the Kysely column map: names, nullability and types (acceptance 7)', async () => {
    const { url } = await migrated();
    for (const [table, columns] of Object.entries(CORE_COLUMNS)) {
      const actual = await onDatabase(url, async (c) =>
        Object.fromEntries(
          (
            await c.query<{ name: string; nullable: string; udt: string }>(
              `select column_name as name, is_nullable as nullable, udt_name as udt
                 from information_schema.columns where table_schema = 'public' and table_name = $1`,
              [table],
            )
          ).rows.map((r) => [r.name, { nullable: r.nullable === 'YES', udt: r.udt }]),
        ),
      );
      expect(actual, table).toEqual(columns);
    }
  });

  it('accepts rows at the limits and fills the defaults', async () => {
    const { db } = await migrated();
    const { userId } = await seed(db);
    const longEmail = `${'a'.repeat(242)}@example.com`;
    expect(longEmail).toHaveLength(254);
    await db
      .insertInto('users')
      .values(user({ email: longEmail, display_name: 'x'.repeat(40), locale: 'pt-BR' }))
      .execute();
    for (const slug of ['abc', 'a'.repeat(40), 'team-42']) {
      await db
        .insertInto('workspaces')
        .values({ id: newId('wsp'), name: 'W', slug, created_by: userId })
        .execute();
    }
    const row = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      locale: 'en',
      telemetry_opt_in: false,
      status: 'active',
      avatar_slot: null,
    });
    expect(row.created_at).toBeInstanceOf(Date);
    const workspace = await db
      .selectFrom('workspaces')
      .select(['settings', 'version'])
      .where('slug', '=', 'acme')
      .executeTakeFirstOrThrow();
    expect(workspace).toEqual({ settings: {}, version: 1 });
    const session = await db.selectFrom('sessions').select('state').executeTakeFirstOrThrow();
    expect(session.state).toBe('pending');
  });

  it('refuses ids with the wrong prefix, and e-mails that differ only by case (acceptance 2)', async () => {
    const { db } = await migrated();
    expect(
      await outcome(
        db
          .insertInto('users')
          .values(user({ id: newId('ses') }))
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await outcome(
        db
          .insertInto('users')
          .values(user({ id: 'usr_lowercase0000000000000000' }))
          .execute(),
      ),
    ).toBe(CHECK);
    await db
      .insertInto('users')
      .values(user({ email: 'ada@example.com' }))
      .execute();
    expect(
      await outcome(
        db
          .insertInto('users')
          .values(user({ email: 'Ada@Example.COM' }))
          .execute(),
      ),
    ).toBe(UNIQUE);
    for (const email of ['not-an-email', 'two@@example.com', `${'a'.repeat(243)}@example.com`]) {
      expect(await outcome(db.insertInto('users').values(user({ email })).execute()), email).toBe(
        CHECK,
      );
    }
  });

  it('refuses unknown roles and a second membership of the same user (acceptance 3)', async () => {
    const { db } = await migrated();
    const { userId, workspaceId } = await seed(db);
    const insertRole = (role: string) =>
      sql`insert into memberships (id, workspace_id, user_id, role) values (${newId('mem')}, ${workspaceId}, ${userId}, ${role})`.execute(
        db,
      );
    expect(await outcome(insertRole('owner2'))).toBe(CHECK);
    expect(await outcome(insertRole('Owner'))).toBe(CHECK);
    expect(await outcome(insertRole('owner'))).toBe('ok');
    expect(await outcome(insertRole('member'))).toBe(UNIQUE);
    // Every CT-RBAC role is accepted.
    const roles = [
      'owner',
      'admin',
      'member',
      'billing',
      'guest',
    ] as const satisfies readonly Api.Role[];
    for (const role of roles) {
      const other = newId('usr');
      await db
        .insertInto('users')
        .values(user({ id: other }))
        .execute();
      await db
        .insertInto('memberships')
        .values({ id: newId('mem'), workspace_id: workspaceId, user_id: other, role })
        .execute();
    }
  });

  it('refuses a display name of 41 characters or none, and bad slugs (acceptance 4)', async () => {
    const { db } = await migrated();
    const { userId } = await seed(db);
    for (const display_name of ['x'.repeat(41), '']) {
      expect(
        await outcome(db.insertInto('users').values(user({ display_name })).execute()),
        display_name,
      ).toBe(CHECK);
    }
    for (const slug of ['ab', 'A-B-C', 'a'.repeat(41), 'has space', 'under_score']) {
      const insert = db
        .insertInto('workspaces')
        .values({ id: newId('wsp'), name: 'W', slug, created_by: userId })
        .execute();
      expect(await outcome(insert), slug).toBe(CHECK);
    }
    expect(
      await outcome(
        db
          .insertInto('workspaces')
          .values({ id: newId('wsp'), name: 'W', slug: 'acme', created_by: userId })
          .execute(),
      ),
    ).toBe(UNIQUE);
  });

  it('refuses a second member in the same slot, and a negative slot (acceptance 5)', async () => {
    const { db } = await migrated();
    const { userId, deviceId, sessionId } = await seed(db);
    const member = (slot: number) =>
      db
        .insertInto('session_members')
        .values({
          id: newId('mem'),
          session_id: sessionId,
          user_id: userId,
          device_id: deviceId,
          role: 'editor',
          slot,
        })
        .execute();
    expect(await outcome(member(0))).toBe('ok');
    expect(await outcome(member(0))).toBe(UNIQUE);
    expect(await outcome(member(-1))).toBe(CHECK);
    expect(await outcome(member(1))).toBe('ok');
  });

  it('blocks deleting a user while devices or memberships reference it (acceptance 6)', async () => {
    const { db } = await migrated();
    const owner = await seed(db);
    const deleteUser = (id: string) => db.deleteFrom('users').where('id', '=', id).execute();

    const withDevice = newId('usr');
    await db
      .insertInto('users')
      .values(user({ id: withDevice }))
      .execute();
    const deviceId = newId('dev');
    await db
      .insertInto('devices')
      .values({
        id: deviceId,
        user_id: withDevice,
        name: 'phone',
        platform: 'other',
        x25519_pub: publicKey(),
        ed25519_pub: publicKey(),
        fingerprint: 'MNOP-QRST-UVWX',
      })
      .execute();
    expect(await outcome(deleteUser(withDevice))).toBe(FOREIGN_KEY);
    await db.deleteFrom('devices').where('id', '=', deviceId).execute();
    expect(await outcome(deleteUser(withDevice))).toBe('ok');

    const member = newId('usr');
    await db
      .insertInto('users')
      .values(user({ id: member }))
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: newId('mem'),
        workspace_id: owner.workspaceId,
        user_id: member,
        role: 'member',
      })
      .execute();
    expect(await outcome(deleteUser(member))).toBe(FOREIGN_KEY);
    expect(await outcome(deleteUser(owner.userId))).toBe(FOREIGN_KEY);
  });

  it('checks the device keys, fingerprint, platform, session state and region formats', async () => {
    const { db } = await migrated();
    const { userId, workspaceId } = await seed(db);
    const device = (overrides: Record<string, string>) =>
      sql`
        insert into devices (id, user_id, name, platform, x25519_pub, ed25519_pub, fingerprint)
        values (${newId('dev')}, ${userId}, ${overrides['name'] ?? 'laptop'}, ${overrides['platform'] ?? 'macos'},
                ${overrides['x25519_pub'] ?? publicKey()}, ${overrides['ed25519_pub'] ?? publicKey()},
                ${overrides['fingerprint'] ?? 'ABCD-EFGH-IJKL'})
      `.execute(db);
    expect(await outcome(device({}))).toBe('ok');
    const bads: Record<string, string>[] = [
      { x25519_pub: publicKey().slice(1) },
      { ed25519_pub: `${publicKey().slice(1)}=` },
      { fingerprint: 'abcd-efgh-ijkl' },
      { fingerprint: 'ABCDEFGHIJKL' },
      { fingerprint: 'ABC1-EFGH-IJKL' },
      { platform: 'ios' },
      { name: '' },
      { name: 'x'.repeat(81) },
    ];
    for (const bad of bads) {
      expect(await outcome(device(bad)), JSON.stringify(bad)).toBe(CHECK);
    }
    const session = (state: string, region: string) =>
      sql`
        insert into sessions (id, workspace_id, name, state, region, created_by)
        values (${newId('ses')}, ${workspaceId}, 'S', ${state}, ${region}, ${userId})
      `.execute(db);
    for (const state of ['pending', 'live', 'paused', 'ended', 'expired'])
      expect(await outcome(session(state, 'us')), state).toBe('ok');
    expect(await outcome(session('running', 'eu'))).toBe(CHECK);
    expect(await outcome(session('live', 'EU'))).toBe(CHECK);
  });

  it('fails clearly when the role may not create the citext extension (failure mode)', async () => {
    const { url, drop } = await tempDatabase();
    const role = `centcom_t_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(18).toString('base64url');
    const quotedRole = pg.escapeIdentifier(role);
    // Role names and passwords cannot be parameters; both are ours, and escaped.
    await onDatabase(url, (c) =>
      c.query(`create role ${quotedRole} login password ${pg.escapeLiteral(password)}`),
    );
    // Cleanups run last-first: close the pool, drop the database (and the table the role owns
    // in it), then the role, from the admin database.
    cleanups.push(
      () =>
        onDatabase(ADMIN_URL ?? '', (c) => c.query(`drop role if exists ${quotedRole}`)).then(
          () => undefined,
        ),
      drop,
    );
    // The role may create tables (the runner's bookkeeping table) but not extensions: trusted
    // extensions need CREATE on the database, which only the owner has here.
    await onDatabase(url, (c) => c.query(`grant create on schema public to ${quotedRole}`));
    const asRole = new URL(url);
    asRole.username = role;
    asRole.password = password;
    const db = createDb<CoreDatabase>({ url: asRole.toString() });
    cleanups.push(() => closeDb(db));
    const err = await migrate(db, MIGRATIONS_DIR).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'MigrationError', code: 'migration_failed' });
    expect(String((err as Error).message)).toMatch(
      /20260101000000_core_schema\.sql failed and was rolled back: permission denied/,
    );
    // Nothing was left behind: no table, no bookkeeping row.
    const tables = await onDatabase(
      url,
      async (c) =>
        (await c.query("select tablename from pg_tables where schemaname = 'public'")).rows,
    );
    expect(
      tables
        .map((t: { tablename: string }) => t.tablename)
        .filter((t: string) => t !== 'schema_migrations'),
    ).toEqual([]);
  });
});

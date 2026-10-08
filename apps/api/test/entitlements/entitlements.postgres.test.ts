/**
 * Entitlements on Postgres 16 (B069; DATABASE_URL, CI's integration job): the migration's seed
 * and backfill, the repository under the service (default row, rev in the change's transaction,
 * ten racing changes moving rev once), deleted workspaces and the purge, and the constraints.
 */
import { randomBytes } from 'node:crypto';
import { newId, validate } from '@centcom/contracts';
import {
  closeDb,
  createDb,
  createWorkspaceStore,
  migrate,
  MIGRATIONS_DIR,
  readMigrations,
  type EntitlementsDb,
} from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createEntitlementRepository,
  EntitlementService,
  GRACE_MS,
  SEED_PLANS,
  type SubscriptionState,
} from '../../src/modules/entitlements/index.js';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
import { catalogOf, Clock, RecordingPublisher } from './helpers.js';

const DAY = 86_400_000;

/** An empty throwaway database (no migrations applied). */
async function emptyDatabase(): Promise<{ db: Kysely<EntitlementsDb>; drop(): Promise<void> }> {
  if (ADMIN_URL === undefined) throw new Error('needs DATABASE_URL');
  const name = `test_${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString('hex')}`;
  const admin = createDb<unknown>({ url: ADMIN_URL, poolMax: 1 });
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = createDb<EntitlementsDb>({ url: url.toString(), poolMax: 12 });
  return {
    db,
    drop: async () => {
      await closeDb(db);
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await closeDb(admin);
    },
  };
}

/** A user and a workspace they created; `deleted` soft-deletes it. */
async function workspace(db: Kysely<EntitlementsDb>, deleted = false): Promise<string> {
  const user = newId('usr');
  await db
    .insertInto('users')
    .values({ id: user, email: `${user.toLowerCase()}@example.test`, display_name: 'Ada' })
    .execute();
  const id = newId('wsp');
  await db
    .insertInto('workspaces')
    .values({
      id,
      name: 'Acme',
      slug: `acme-${randomBytes(4).toString('hex')}`,
      created_by: user,
      ...(deleted ? { deleted_at: new Date() } : {}),
    })
    .execute();
  return id;
}

const row = (db: Kysely<EntitlementsDb>, id: string) =>
  db
    .selectFrom('workspace_entitlements')
    .selectAll()
    .where('workspace_id', '=', id)
    .executeTakeFirst();

describe.runIf(ADMIN_URL !== undefined)('entitlements on Postgres 16', () => {
  it('the migration seeds the reference plans and backfills live workspaces', async () => {
    const t = await emptyDatabase();
    try {
      const files = await readMigrations(MIGRATIONS_DIR);
      const at = files.findIndex((f) => f.name === 'plans_entitlements');
      expect(at).toBeGreaterThan(0);
      await migrate(t.db, MIGRATIONS_DIR, { target: files[at - 1]?.version ?? '' });
      const live = await workspace(t.db);
      const gone = await workspace(t.db, true);
      await migrate(t.db, MIGRATIONS_DIR);
      expect(await row(t.db, live)).toMatchObject({
        plan_id: 'free',
        status: 'none',
        rev: 0,
        addon_seats: 0,
        resolved_digest: null,
        grace_until: null,
      });
      expect(await row(t.db, gone)).toBeUndefined();
      expect(await createEntitlementRepository(t.db).plans()).toEqual(catalogOf(SEED_PLANS));
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('applies, reads, races and purges through the service', async () => {
    const t = await migratedDatabase(12);
    const db = t.db as unknown as Kysely<EntitlementsDb>;
    try {
      const id = await workspace(db);
      const repository = createEntitlementRepository(db);
      const events = new RecordingPublisher();
      const clock = new Clock();
      const service = new EntitlementService({ repository, events, clock: clock.read });
      const state = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
        plan: 'pro',
        status: 'active',
        period: { start: new Date(clock.now - DAY), end: new Date(clock.now + 29 * DAY) },
        past_due_since: null,
        addon_seats: 0,
        ...over,
      });

      // A first read writes the default row.
      await db.deleteFrom('workspace_entitlements').where('workspace_id', '=', id).execute();
      expect(await service.get(id)).toMatchObject({ rev: 0, plan: 'free', status: 'none' });
      expect(await row(db, id)).toMatchObject({ rev: 0, plan_id: 'free' });

      expect(await service.applySubscriptionState(id, state())).toEqual({ rev: 1, changed: true });
      expect(await service.applySubscriptionState(id, state())).toEqual({ rev: 1, changed: false });
      const stored = await row(db, id);
      expect(stored?.resolved_digest).toHaveLength(32);
      const got = await service.get(id);
      expect(got).toMatchObject({ rev: 1, plan: 'pro', limits: SEED_PLANS.pro.limits });
      expect(validate('entitlements', got).ok).toBe(true);

      // Past due, then grace ends: the read moves rev on, under the row lock.
      const since = new Date(clock.now);
      await service.applySubscriptionState(
        id,
        state({ status: 'past_due', past_due_since: since }),
      );
      expect((await row(db, id))?.grace_until).toEqual(new Date(since.getTime() + GRACE_MS));
      clock.advance(GRACE_MS + 1000);
      expect(await service.get(id)).toMatchObject({ rev: 3, plan: 'free', status: 'none' });
      expect((await row(db, id))?.rev).toBe(3);
      expect(await service.bumpRev(id, 'usage_warning')).toBe(4);

      // Ten racers with one change: rev moves once.
      const team = state({ plan: 'team', addon_seats: 2 });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.applySubscriptionState(id, team)),
      );
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.rev))).toEqual(new Set([5]));
      expect(await service.get(id)).toMatchObject({
        rev: 5,
        plan: 'team',
        limits: { max_seats: 7 },
      });
      expect(events.payloads().map((p) => p.rev)).toEqual([1, 2, 3, 4, 5]);

      // Deleted: reads are null, changes 404, and the purge needs the hook first.
      const other = await workspace(db);
      await db
        .updateTable('workspaces')
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .execute();
      expect(await service.get(id)).toBeNull();
      await expect(service.applySubscriptionState(id, state())).rejects.toMatchObject({
        status: 404,
      });
      await service.get(other);
      expect(await repository.deleteForWorkspace(other)).toBe(0);
      const store = createWorkspaceStore(db);
      await expect(store.purge(id)).rejects.toThrow();
      expect(await repository.deleteForWorkspace(id)).toBe(1);
      expect(await repository.deleteForWorkspace(id)).toBe(0);
      expect(await store.purge(id)).toEqual({ purged: true });
      expect(await row(db, other)).toBeDefined();
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('the tables refuse what the contract does not allow', async () => {
    const t = await migratedDatabase(2);
    const db = t.db as unknown as Kysely<EntitlementsDb>;
    try {
      const id = await workspace(db);
      const refuses = async (statement: Promise<unknown>): Promise<void> => {
        await expect(statement).rejects.toThrow(/violates/);
      };
      await refuses(
        sql`insert into plans (id, name) values ('enterprise', 'Enterprise')`.execute(db),
      );
      await refuses(
        sql`insert into plan_limits (plan_id, key, int_value) values ('pro', 'max_projects', 1)`.execute(
          db,
        ),
      );
      await refuses(
        sql`update plan_limits set bool_value = false where plan_id = 'pro' and key = 'lan_multiplayer'`.execute(
          db,
        ),
      );
      await refuses(
        sql`update plan_limits set bool_value = true where plan_id = 'pro' and key = 'max_seats'`.execute(
          db,
        ),
      );
      await refuses(
        sql`update plan_limits set int_value = -1 where plan_id = 'pro' and key = 'max_seats'`.execute(
          db,
        ),
      );
      await refuses(
        sql`insert into workspace_entitlements (workspace_id, status) values (${id}, 'past_due')`.execute(
          db,
        ),
      );
      await refuses(
        sql`insert into workspace_entitlements (workspace_id, status) values (${id}, 'paused')`.execute(
          db,
        ),
      );
      await refuses(
        sql`insert into workspace_entitlements (workspace_id, addon_seats) values (${id}, -1)`.execute(
          db,
        ),
      );
      await refuses(
        sql`insert into workspace_entitlements (workspace_id, period_start) values (${id}, now())`.execute(
          db,
        ),
      );
      await refuses(
        sql`insert into workspace_entitlements (workspace_id, resolved_digest) values (${id}, '\\x00')`.execute(
          db,
        ),
      );
      await refuses(
        sql`insert into workspace_entitlements (workspace_id) values (${newId('wsp')})`.execute(db),
      );
    } finally {
      await t.drop();
    }
  }, 60_000);
});

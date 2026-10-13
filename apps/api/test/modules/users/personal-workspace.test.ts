/**
 * The personal workspace (B013 acceptance 3), against a real Postgres 16: the first sign-in
 * creates the user, a workspace named after them and their `owner` membership together, and a
 * failure in either insert leaves none of the three.
 */
import type { IdPrefix } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalSlug, UserService } from '../../../src/modules/users/index.js';
import { ADMIN_URL, counts, migratedDatabase, newId, NOW, type TestDatabase } from './helpers.js';

describe('personalSlug', () => {
  it('is a valid, unique slug made from the workspace id', () => {
    const id = newId('wsp');
    expect(personalSlug(id)).toMatch(/^p-[0-9a-z]{26}$/);
    expect(personalSlug(id)).toMatch(/^[a-z0-9-]{3,40}$/);
    expect(personalSlug(newId('wsp'))).not.toBe(personalSlug(id));
  });
});

describe.runIf(ADMIN_URL !== undefined)('the personal workspace on Postgres 16', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await migratedDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  it('is created with the user: named after them, owned by them, in one go (acceptance 3)', async () => {
    const service = new UserService({ db: t.db, newId, now: () => NOW });
    const { user, created } = await service.getOrCreateByEmail('owner@example.test', {
      name: 'Margaret Hamilton',
    });
    expect(created).toBe(true);
    expect(user.display_name).toBe('Margaret Hamilton');
    const workspaces = await t.db
      .selectFrom('workspaces')
      .selectAll()
      .where('created_by', '=', user.id)
      .execute();
    expect(workspaces).toHaveLength(1);
    const [workspace] = workspaces;
    expect(workspace).toMatchObject({
      name: 'Margaret Hamilton',
      created_at: NOW,
      deleted_at: null,
    });
    expect(workspace?.slug).toBe(personalSlug(workspace?.id ?? ''));
    const memberships = await t.db
      .selectFrom('memberships')
      .selectAll()
      .where('user_id', '=', user.id)
      .execute();
    expect(memberships).toEqual([
      expect.objectContaining({ workspace_id: workspace?.id, role: 'owner' }),
    ]);
  });

  it('writes no plan of its own: a production sign-up is on the free plan (B103/B106)', async () => {
    // Production wires no `onCreated` (a paid default plan exists only with DEV_DEFAULT_PLAN, which
    // the configuration refuses under NODE_ENV=production), and a workspace with no entitlements
    // row resolves to the free plan (no relay, B069).
    const service = new UserService({ db: t.db, newId, now: () => NOW });
    const { user } = await service.getOrCreateByEmail('free-plan@example.test', {
      name: 'Free Person',
    });
    const workspace = await t.db
      .selectFrom('workspaces')
      .select('id')
      .where('created_by', '=', user.id)
      .executeTakeFirstOrThrow();
    const rows = await (
      t.db as unknown as {
        selectFrom(t: string): {
          selectAll(): {
            where(c: string, o: string, v: string): { execute(): Promise<unknown[]> };
          };
        };
      }
    )
      .selectFrom('workspace_entitlements')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .execute();
    expect(rows).toEqual([]);
  });

  it('hands the new user and workspace to onCreated, in the same transaction (a throw undoes the sign-up)', async () => {
    const seen: { userId: string; workspaceId: string }[] = [];
    const service = new UserService({
      db: t.db,
      newId,
      now: () => NOW,
      onCreated: (trx, created) => {
        seen.push(created);
        return trx
          .selectFrom('memberships')
          .select('id')
          .where('workspace_id', '=', created.workspaceId)
          .where('user_id', '=', created.userId)
          .executeTakeFirstOrThrow()
          .then(() => undefined);
      },
    });
    const { user } = await service.getOrCreateByEmail('hook@example.test');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.userId).toBe(user.id);
    // A second sign-in creates nothing, so the hook does not run again.
    await service.getOrCreateByEmail('hook@example.test');
    expect(seen).toHaveLength(1);

    const before = await counts(t.db);
    const failing = new UserService({
      db: t.db,
      newId,
      now: () => NOW,
      onCreated: () => Promise.reject(new Error('no plan')),
    });
    await expect(failing.getOrCreateByEmail('late@example.test')).rejects.toThrow('no plan');
    expect(await counts(t.db)).toEqual(before);
  });

  it.each([
    ['the workspace', 'wsp'],
    ['the membership', 'mem'],
  ] as const)(
    'rolls back the user when %s cannot be inserted (acceptance 3)',
    async (_what, broken: IdPrefix) => {
      const before = await counts(t.db);
      // An id the table's check refuses makes that one insert fail.
      const faulty = (prefix: IdPrefix): string =>
        prefix === broken ? `${prefix}_not-a-ulid` : newId(prefix);
      const service = new UserService({ db: t.db, newId: faulty, now: () => NOW });
      await expect(
        service.getOrCreateByEmail(`rollback-${broken}@example.test`),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await counts(t.db)).toEqual(before);
      expect(
        await t.db
          .selectFrom('users')
          .select('id')
          .where('email', '=', `rollback-${broken}@example.test`)
          .execute(),
      ).toEqual([]);
    },
  );
});

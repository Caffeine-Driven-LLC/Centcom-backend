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

/**
 * The user service (B013). Without a database: an existing user is returned without a write, an
 * invalid address fails before any query, a lost creation race returns the winner, other errors
 * pass through, and profile patches are checked first. Against a real Postgres 16: the same user
 * for any case of an address (acceptance 1), 50 concurrent first sign-ins making one user and one
 * workspace (acceptance 2), and profile rules end to end (acceptance 4 and 5).
 */
import { AppError } from '@centcom/core';
import { type User, type UserRepo } from '@centcom/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserService } from '../../../src/modules/users/index.js';
import {
  ADMIN_URL,
  counts,
  migratedDatabase,
  newId,
  NOW,
  scriptedDb,
  uniqueViolation,
  userRow,
  type TestDatabase,
} from './helpers.js';

/** A repository whose lookups answer from `found` in turn (the last one repeats), recording calls. */
function fakeRepo(found: (User | null)[] = [null]): UserRepo & { calls: string[] } {
  const calls: string[] = [];
  const next = (): User | null => (found.length > 1 ? (found.shift() ?? null) : (found[0] ?? null));
  const fail = (name: string) => (): never => {
    throw new Error(`${name} should not be called`);
  };
  return {
    calls,
    findByEmail: (email) => {
      calls.push(`findByEmail ${email}`);
      return Promise.resolve(next());
    },
    findById: fail('findById'),
    create: fail('create'),
    markDeletionRequested: fail('markDeletionRequested'),
    markDeleted: fail('markDeleted'),
    listByIds: fail('listByIds'),
    updateProfile: (id, patch) => {
      calls.push(`updateProfile ${id} ${JSON.stringify(patch)}`);
      return Promise.resolve(userRow({ id, ...patch }));
    },
  };
}

describe('the service without a database', () => {
  it('returns an existing user without writing anything', async () => {
    const user = userRow({ email: 'grace@example.test' });
    const repo = fakeRepo([user]);
    const { db, statements } = scriptedDb();
    const service = new UserService({ db, repo, newId, now: () => NOW });
    expect(await service.getOrCreateByEmail('Grace@Example.TEST')).toEqual({
      user,
      created: false,
    });
    expect(repo.calls).toEqual(['findByEmail grace@example.test']);
    expect(statements).toEqual([]);
  });

  it('refuses an invalid address with a validation AppError before any query', async () => {
    const repo = fakeRepo();
    const { db, statements } = scriptedDb();
    const service = new UserService({ db, repo, newId, now: () => NOW });
    for (const email of ['not-an-address', '', 'a@b@c']) {
      const err: unknown = await service.getOrCreateByEmail(email).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'validation_failed', errors: [{ pointer: '/email' }] });
    }
    expect(repo.calls).toEqual([]);
    expect(statements).toEqual([]);
  });

  it('creates user, workspace and owner membership in one transaction', async () => {
    const { db, statements } = scriptedDb((query) =>
      query.sql.startsWith('insert into "users"')
        ? { rows: [userRow({ id: query.parameters[0] as string })] }
        : {},
    );
    const service = new UserService({ db, repo: fakeRepo(), newId, now: () => NOW });
    const { created } = await service.getOrCreateByEmail('new@example.test');
    expect(created).toBe(true);
    expect(statements.map((s) => s.split(' (')[0])).toEqual([
      'begin',
      'insert into "users"',
      'insert into "workspaces"',
      'insert into "memberships"',
      'commit',
    ]);
  });

  it('returns the winner when another sign-in created the address first (unique-violation race)', async () => {
    const winner = userRow({ email: 'race@example.test' });
    const repo = fakeRepo([null, winner]);
    const { db, statements } = scriptedDb((query) =>
      query.sql.startsWith('insert into "users"') ? uniqueViolation('users_email_key') : {},
    );
    const service = new UserService({ db, repo, newId, now: () => NOW });
    expect(await service.getOrCreateByEmail('race@example.test')).toEqual({
      user: winner,
      created: false,
    });
    expect(statements).toEqual([
      'begin',
      expect.stringContaining('insert into "users"') as string,
      'rollback',
    ]);
    expect(repo.calls).toHaveLength(2);
  });

  it('passes other failures through, rolled back', async () => {
    const outage = new AppError('service_unavailable');
    const { db, statements } = scriptedDb((query) =>
      query.sql.startsWith('insert into "workspaces"') ? outage : { rows: [userRow()] },
    );
    const service = new UserService({ db, repo: fakeRepo(), newId, now: () => NOW });
    await expect(service.getOrCreateByEmail('down@example.test')).rejects.toBe(outage);
    expect(statements.at(-1)).toBe('rollback');

    // A unique violation whose winner cannot be read back is not swallowed either.
    const lost = uniqueViolation('users_email_key');
    const ghost = new UserService({
      db: scriptedDb(() => lost).db,
      repo: fakeRepo([null]),
      newId,
      now: () => NOW,
    });
    await expect(ghost.getOrCreateByEmail('ghost@example.test')).rejects.toBe(lost);
  });

  it('answers a lost database connection with a 503 and leaves no partial user', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const { db, statements } = scriptedDb((query) =>
      query.sql.startsWith('insert into "workspaces"') ? down : { rows: [userRow()] },
    );
    const service = new UserService({ db, repo: fakeRepo(), newId, now: () => NOW });
    const err: unknown = await service
      .getOrCreateByEmail('down@example.test')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(statements.at(-1)).toBe('rollback');

    const lookup = new UserService({
      db: scriptedDb().db,
      repo: { ...fakeRepo(), findByEmail: () => Promise.reject(down) },
      newId,
      now: () => NOW,
    });
    await expect(lookup.getOrCreateByEmail('down@example.test')).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });

  it('checks a profile patch before it reaches the repository', async () => {
    const repo = fakeRepo();
    const service = new UserService({ db: scriptedDb().db, repo, newId, now: () => NOW });
    const id = newId('usr');
    await expect(service.updateProfile(id, { display_name: '' })).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: '/display_name', code: 'too_short' }],
    });
    expect(repo.calls).toEqual([]);
    await service.updateProfile(id, { locale: 'en-gb' });
    expect(repo.calls).toEqual([`updateProfile ${id} {"locale":"en-GB"}`]);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the service on Postgres 16', () => {
  let t: TestDatabase;
  let service: UserService;
  beforeAll(async () => {
    t = await migratedDatabase();
    service = new UserService({ db: t.db, newId, now: () => new Date() });
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  it("returns the same user for 'A@Example.COM' and then 'a@example.com', created only once (acceptance 1)", async () => {
    const first = await service.getOrCreateByEmail('A@Example.COM');
    const second = await service.getOrCreateByEmail('a@example.com');
    expect(first.created).toBe(true);
    expect(second).toEqual({ user: first.user, created: false });
    expect(first.user).toMatchObject({ email: 'a@example.com', display_name: 'a', locale: 'en' });
  });

  it('makes exactly one user and one personal workspace from 50 concurrent first sign-ins (acceptance 2)', async () => {
    const before = await counts(t.db);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.getOrCreateByEmail('Rush@Example.test')),
    );
    expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const after = await counts(t.db);
    expect(after).toEqual({
      users: before.users + 1,
      workspaces: before.workspaces + 1,
      memberships: before.memberships + 1,
    });
  });

  it('applies the profile rules end to end (acceptance 4 and 5)', async () => {
    const { user } = await service.getOrCreateByEmail('profile@example.test');
    expect(user.locale).toBe('en');
    for (const bad of [
      { display_name: '' },
      { display_name: 'x'.repeat(41) },
      { display_name: 'a\u0000b' },
    ]) {
      await expect(service.updateProfile(user.id, bad)).rejects.toMatchObject({
        code: 'validation_failed',
        errors: [{ pointer: '/display_name' }],
      });
    }
    await expect(service.updateProfile(user.id, { locale: 'english' })).rejects.toMatchObject({
      errors: [{ pointer: '/locale' }],
    });
    const updated = await service.updateProfile(user.id, { display_name: 'Zoé', locale: 'en-GB' });
    expect(updated).toMatchObject({ display_name: 'Zoé', locale: 'en-GB' });
    expect(
      (
        await t.db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow()
      ).display_name,
    ).toBe('Zoé');
  });
});

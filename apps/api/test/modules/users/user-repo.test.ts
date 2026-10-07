/**
 * The user repository (B013). Without a database, over a scripted driver: the exact column list
 * (acceptance 7), no query for an address that cannot exist or an empty id list, and 404s. Against
 * a real Postgres 16 (DATABASE_URL, CI's integration job): CRUD, case-insensitive e-mail,
 * deletion states still found (acceptance 6), and no column beyond `User` even after the table
 * grows one (acceptance 7).
 */
import { AppError } from '@centcom/core';
import { createUserRepo, isEmailTaken, USER_COLUMNS, type User } from '@centcom/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_URL,
  migratedDatabase,
  newId,
  scriptedDb,
  uniqueViolation,
  type TestDatabase,
} from './helpers.js';

/** Every field of `User`, checked by tsc: a missing or extra key fails the typecheck. */
const USER_KEYS = {
  id: true,
  email: true,
  display_name: true,
  locale: true,
  avatar_slot: true,
  telemetry_opt_in: true,
  status: true,
  deletion_requested_at: true,
  created_at: true,
  updated_at: true,
} satisfies Record<keyof User, true>;

describe('the repository without a database', () => {
  it('selects exactly the columns of User, never * (acceptance 7)', async () => {
    expect([...USER_COLUMNS].sort()).toEqual(Object.keys(USER_KEYS).sort());
    const { db, statements } = scriptedDb();
    const repo = createUserRepo(db);
    await repo.findById(newId('usr'));
    await repo.findByEmail('A@Example.TEST');
    await repo.listByIds([newId('usr')]);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).not.toContain('*');
      for (const column of USER_COLUMNS) expect(statement).toContain(`"${column}"`);
    }
  });

  it('looks up the normalised address, and sends no query for one that cannot exist', async () => {
    const { db, statements } = scriptedDb((query) => {
      expect(query.parameters).toContain('a@example.test');
      return {};
    });
    const repo = createUserRepo(db);
    expect(await repo.findByEmail('A@Example.TEST')).toBeNull();
    expect(statements).toHaveLength(1);
    expect(await repo.findByEmail('nul\u0000@example.test')).toBeNull();
    expect(await repo.listByIds([])).toEqual([]);
    expect(statements).toHaveLength(1);
    await expect(
      repo.create({ id: newId('usr'), email: '\u0000', display_name: 'X' }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: '/email' }],
    });
    expect(statements).toHaveLength(1);
  });

  it('answers 404 for a user that does not exist', async () => {
    const repo = createUserRepo(scriptedDb(() => ({ rows: [], affected: 0n })).db);
    for (const call of [
      () => repo.updateProfile(newId('usr'), { locale: 'fr' }),
      () => repo.markDeletionRequested(newId('usr'), new Date()),
      () => repo.markDeleted(newId('usr')),
    ]) {
      const err: unknown = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'not_found', status: 404 });
    }
  });

  it('recognises the unique violation of a taken address, and only that one', () => {
    expect(isEmailTaken(uniqueViolation('users_email_key'))).toBe(true);
    expect(isEmailTaken(uniqueViolation('workspaces_slug_key'))).toBe(false);
    expect(
      isEmailTaken(Object.assign(new Error('x'), { code: '23503', constraint: 'users_email_key' })),
    ).toBe(false);
    expect(isEmailTaken(null)).toBe(false);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the repository on Postgres 16', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await migratedDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  it('creates, finds by id and by e-mail in any case, and stores the address lower-cased', async () => {
    const repo = createUserRepo(t.db);
    const id = newId('usr');
    const created = await repo.create({ id, email: 'Ada@Example.TEST', display_name: 'Ada' });
    expect(created).toMatchObject({
      id,
      email: 'ada@example.test',
      locale: 'en',
      status: 'active',
      avatar_slot: null,
    });
    expect(created.created_at).toBeInstanceOf(Date);
    expect(await repo.findById(id)).toEqual(created);
    expect(await repo.findByEmail('ADA@example.test')).toEqual(created);
    expect(await repo.findByEmail('ada@EXAMPLE.TEST')).toEqual(created);
    expect(await repo.findById(newId('usr'))).toBeNull();
    expect(await repo.findByEmail('nobody@example.test')).toBeNull();

    const err: unknown = await repo
      .create({ id: newId('usr'), email: 'ADA@EXAMPLE.TEST', display_name: 'Ada again' })
      .catch((e: unknown) => e);
    expect(isEmailTaken(err)).toBe(true);
  });

  it('updates the profile and bumps updated_at', async () => {
    const repo = createUserRepo(t.db);
    const user = await repo.create({
      id: newId('usr'),
      email: `${newId('req').toLowerCase()}@example.test`,
      display_name: 'Lin',
    });
    await sql`select pg_sleep(0.01)`.execute(t.db);
    const updated = await repo.updateProfile(user.id, {
      display_name: 'Lin Q',
      locale: 'fr',
      avatar_slot: 'slot-2',
      telemetry_opt_in: true,
    });
    expect(updated).toMatchObject({
      display_name: 'Lin Q',
      locale: 'fr',
      avatar_slot: 'slot-2',
      telemetry_opt_in: true,
    });
    expect(updated.updated_at.getTime()).toBeGreaterThan(user.updated_at.getTime());
    expect((await repo.updateProfile(user.id, { avatar_slot: null })).avatar_slot).toBeNull();
    await expect(repo.updateProfile(newId('usr'), { locale: 'en' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keeps finding users pending deletion or deleted, with their status (acceptance 6)', async () => {
    const repo = createUserRepo(t.db);
    const pending = await repo.create({
      id: newId('usr'),
      email: 'pending@example.test',
      display_name: 'P',
    });
    const gone = await repo.create({
      id: newId('usr'),
      email: 'gone@example.test',
      display_name: 'G',
    });
    const at = new Date('2026-10-01T00:00:00.000Z');
    await repo.markDeletionRequested(pending.id, at);
    await repo.markDeleted(gone.id);
    expect(await repo.findById(pending.id)).toMatchObject({
      status: 'pending_deletion',
      deletion_requested_at: at,
    });
    expect(await repo.findByEmail('PENDING@example.test')).toMatchObject({
      id: pending.id,
      status: 'pending_deletion',
    });
    expect(await repo.findById(gone.id)).toMatchObject({ status: 'deleted' });
    expect(await repo.findByEmail('gone@example.test')).toMatchObject({
      id: gone.id,
      status: 'deleted',
    });
    await expect(repo.markDeleted(newId('usr'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists users by id in the order asked, once each, skipping unknown ids', async () => {
    const repo = createUserRepo(t.db);
    const [a, b] = await Promise.all(
      ['list-a', 'list-b'].map((name) =>
        repo.create({ id: newId('usr'), email: `${name}@example.test`, display_name: name }),
      ),
    );
    const ids = [b?.id ?? '', newId('usr'), a?.id ?? '', b?.id ?? ''];
    expect((await repo.listByIds(ids)).map((user) => user.id)).toEqual([b?.id, a?.id]);
  });

  it('returns no column beyond User, even after the table grows one (acceptance 7)', async () => {
    await sql`alter table users add column internal_note text not null default 'never leaves the database'`.execute(
      t.db,
    );
    try {
      const repo = createUserRepo(t.db);
      const user = await repo.create({
        id: newId('usr'),
        email: 'leak@example.test',
        display_name: 'Leak',
      });
      const results = [
        user,
        await repo.findById(user.id),
        await repo.findByEmail(user.email),
        await repo.updateProfile(user.id, { locale: 'de' }),
        ...(await repo.listByIds([user.id])),
      ];
      for (const result of results)
        expect(Object.keys(result ?? {}).sort()).toEqual(Object.keys(USER_KEYS).sort());
    } finally {
      await sql`alter table users drop column internal_note`.execute(t.db);
    }
  });
});

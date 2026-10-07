/**
 * Account matching (B015 acceptance 5 and 6, card test linking.test.ts): an account seen before
 * returns to its user whatever its e-mail now; a verified e-mail of an existing user links to that
 * user with one identity row; concurrent first logins of one account make one user and one
 * identity. In memory, and against a real Postgres 16 (DATABASE_URL, CI's integration job) with
 * B013's user service and the identities table.
 */
import { newId } from '@centcom/contracts';
import type { SocialDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIdentityRepo,
  isIdentityTaken,
  SocialLoginService,
  type IdentityRepo,
} from '../../../../src/modules/auth/social/index.js';
import { UserService } from '../../../../src/modules/users/index.js';
import { ADMIN_URL, counts, migratedDatabase, type TestDatabase } from '../../users/helpers.js';
import { begun, fakeProviders, socialService, testConfig } from './helpers.js';

describe('account matching in memory', () => {
  it('returns an account to the same user even after its e-mail changed at the provider (acceptance 5)', async () => {
    const { service, providers, users, identities } = socialService();
    let login = await begun(service, providers, 'github');
    const first = await service.complete(
      'github',
      { code: 'c1', state: login.state },
      login.cookie,
    );
    providers.github.emails = [{ email: 'renamed@example.test', primary: true, verified: true }];
    login = await begun(service, providers, 'github');
    const second = await service.complete(
      'github',
      { code: 'c2', state: login.state },
      login.cookie,
    );
    expect(second).toMatchObject({ userId: first.userId, created: false });
    expect(users.users.size).toBe(1);
    expect(identities.rows.size).toBe(1);
  });

  it('links a verified e-mail of an existing user to that user, writing one identity (acceptance 5)', async () => {
    const { service, providers, users, identities } = socialService();
    const existing = (await users.getOrCreateByEmail('Gina@Example.test')).user;
    const login = await begun(service, providers, 'google');
    const done = await service.complete('google', { code: 'c', state: login.state }, login.cookie);
    expect(done).toMatchObject({ userId: existing.id, created: false });
    expect([...identities.rows.entries()]).toEqual([['google|108000000000000000001', existing.id]]);
  });

  it('treats the same address from both providers as one user with two identities', async () => {
    const { service, providers, identities } = socialService();
    providers.github.emails = [{ email: 'gina@example.test', primary: true, verified: true }];
    let login = await begun(service, providers, 'github');
    const viaGithub = await service.complete(
      'github',
      { code: 'c', state: login.state },
      login.cookie,
    );
    login = await begun(service, providers, 'google');
    const viaGoogle = await service.complete(
      'google',
      { code: 'c', state: login.state },
      login.cookie,
    );
    expect(viaGoogle.userId).toBe(viaGithub.userId);
    expect(identities.rows.size).toBe(2);
  });

  it('lets the first link win when two logins of one account race (acceptance 6)', async () => {
    const base = socialService();
    // Both logins pass the identity lookup before either links.
    let lookups = 0;
    let release: () => void = () => undefined;
    const bothLookedUp = new Promise<void>((resolve) => (release = resolve));
    const racing: IdentityRepo = {
      findUserId: async (provider, subject) => {
        const found = await base.identities.findUserId(provider, subject);
        if (found === null && ++lookups === 2) release();
        if (found === null && lookups <= 2) await bothLookedUp;
        return found;
      },
      link: (provider, subject, userId) => base.identities.link(provider, subject, userId),
    };
    const service = new SocialLoginService({
      config: base.config,
      users: base.users,
      identities: racing,
      fetch: base.providers.fetch,
      now: base.clock.now,
    });
    const a = await begun(service, base.providers, 'github');
    const b = await begun(service, base.providers, 'github');
    const [x, y] = await Promise.all([
      service.complete('github', { code: 'a', state: a.state }, a.cookie),
      service.complete('github', { code: 'b', state: b.state }, b.cookie),
    ]);
    expect(x.userId).toBe(y.userId);
    expect(base.users.users.size).toBe(1);
    expect(base.identities.rows.size).toBe(1);
  });

  it('signs the loser of a link race in as the winner’s user, not one of its own', async () => {
    // Two logins of one account resolve to different users (its e-mail changed between them):
    // whoever links first decides the user, and the other login must follow that link.
    const base = socialService();
    let calls = 0;
    const users = {
      getOrCreateByEmail: async (email: string) => {
        calls += 1;
        return base.users.getOrCreateByEmail(`${calls}-${email}`);
      },
    };
    let lookups = 0;
    let release: () => void = () => undefined;
    const bothLookedUp = new Promise<void>((resolve) => (release = resolve));
    const racing: IdentityRepo = {
      findUserId: async (provider, subject) => {
        const found = await base.identities.findUserId(provider, subject);
        if (found === null && ++lookups === 2) release();
        if (found === null && lookups <= 2) await bothLookedUp;
        return found;
      },
      link: (provider, subject, userId) => base.identities.link(provider, subject, userId),
    };
    const service = new SocialLoginService({
      config: base.config,
      users,
      identities: racing,
      fetch: base.providers.fetch,
      now: base.clock.now,
    });
    const a = await begun(service, base.providers, 'github');
    const b = await begun(service, base.providers, 'github');
    const results = await Promise.all([
      service.complete('github', { code: 'a', state: a.state }, a.cookie),
      service.complete('github', { code: 'b', state: b.state }, b.cookie),
    ]);
    const linked = [...base.identities.rows.values()];
    expect(linked).toHaveLength(1);
    expect(results.map((r) => r.userId)).toEqual([linked[0], linked[0]]);
  });

  it('refuses a provider address the user rules refuse, as having no usable e-mail', async () => {
    const { service, providers, users } = socialService();
    providers.github.emails = [{ email: 'not an address', primary: true, verified: true }];
    const login = await begun(service, providers, 'github');
    await expect(
      service.complete('github', { code: 'c', state: login.state }, login.cookie),
    ).rejects.toMatchObject({
      reason: 'no_verified_email',
    });
    expect(users.users.size).toBe(0);
  });
});

describe.runIf(ADMIN_URL !== undefined)('account matching on Postgres 16', () => {
  let t: TestDatabase;
  let db: Kysely<SocialDatabase>;
  beforeAll(async () => {
    t = await migratedDatabase();
    db = t.db as unknown as Kysely<SocialDatabase>;
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  const serviceOn = (
    providers = fakeProviders(),
  ): { service: SocialLoginService; providers: typeof providers } => ({
    providers,
    service: new SocialLoginService({
      config: testConfig(),
      users: new UserService({ db: t.db, newId, now: () => new Date() }),
      identities: createIdentityRepo(db),
      fetch: providers.fetch,
    }),
  });

  it('links, refuses a second link of one account, and finds it again', async () => {
    const repo = createIdentityRepo(db);
    const { user } = await new UserService({
      db: t.db,
      newId,
      now: () => new Date(),
    }).getOrCreateByEmail('linked@example.test');
    expect(await repo.findUserId('github', '1')).toBeNull();
    expect(await repo.link('github', '1', user.id)).toBe(true);
    expect(await repo.link('github', '1', user.id)).toBe(false);
    expect(await repo.findUserId('github', '1')).toBe(user.id);
    expect(await repo.findUserId('google', '1')).toBeNull();
    const err = await db
      .insertInto('identities')
      .values({ provider: 'github', subject: '1', user_id: user.id })
      .execute()
      .catch((e: unknown) => e);
    expect(isIdentityTaken(err)).toBe(true);
  });

  it('makes one user and one identity from two concurrent first logins of one account (acceptance 6)', async () => {
    const { service, providers } = serviceOn();
    providers.github.user = { id: 777_000, login: 'racer', name: 'Racer' };
    providers.github.emails = [{ email: 'racer@example.test', primary: true, verified: true }];
    const before = await counts(t.db);
    const logins = await Promise.all([
      begun(service, providers, 'github'),
      begun(service, providers, 'github'),
    ]);
    const results = await Promise.all(
      logins.map((login) =>
        service.complete('github', { code: 'c', state: login.state }, login.cookie),
      ),
    );
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect((await counts(t.db)).users).toBe(before.users + 1);
    const identities = await db
      .selectFrom('identities')
      .selectAll()
      .where('subject', '=', '777000')
      .execute();
    expect(identities).toEqual([
      expect.objectContaining({ provider: 'github', user_id: results[0]?.userId }),
    ]);
  });

  it('returns a known account to its user after an e-mail change, and links an existing user by verified e-mail (acceptance 5)', async () => {
    const { service, providers } = serviceOn();
    providers.github.user = { id: 888_000, login: 'mover', name: null };
    providers.github.emails = [{ email: 'mover@example.test', primary: true, verified: true }];
    let login = await begun(service, providers, 'github');
    const first = await service.complete('github', { code: 'c', state: login.state }, login.cookie);
    providers.github.emails = [{ email: 'moved@example.test', primary: true, verified: true }];
    login = await begun(service, providers, 'github');
    expect(
      (await service.complete('github', { code: 'c', state: login.state }, login.cookie)).userId,
    ).toBe(first.userId);

    const existing = await new UserService({
      db: t.db,
      newId,
      now: () => new Date(),
    }).getOrCreateByEmail('gina@example.test');
    login = await begun(service, providers, 'google');
    const viaGoogle = await service.complete(
      'google',
      { code: 'c', state: login.state },
      login.cookie,
    );
    expect(viaGoogle).toMatchObject({ userId: existing.user.id, created: false });
    expect(
      await db
        .selectFrom('identities')
        .select('user_id')
        .where('provider', '=', 'google')
        .execute(),
    ).toEqual([{ user_id: existing.user.id }]);
  });
});

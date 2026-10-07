/**
 * No provider secrets kept (B015 acceptance 7, card test leak.test.ts): logs and pages of
 * successful and failed logins hold no authorization code, provider token, client secret, state
 * or e-mail address; and in a real Postgres 16 (CI's integration job) the identities table has
 * only provider, subject, user and time, with no provider token or code anywhere after a login.
 */
import { newId } from '@centcom/contracts';
import type { SocialDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIdentityRepo,
  SocialLoginService,
} from '../../../../src/modules/auth/social/index.js';
import { UserService } from '../../../../src/modules/users/index.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../../users/helpers.js';
import {
  begun,
  fakeProviders,
  runtimeSecret,
  socialApp,
  socialService,
  testConfig,
} from './helpers.js';

const cookieOf = (setCookie: string | string[] | undefined): string =>
  (Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? ''))?.split(';')[0] ?? '';

describe('logs and pages', () => {
  it('hold no code, token, secret, state or e-mail address, for successful and failed logins (acceptance 7)', async () => {
    const { service, providers, config } = socialService();
    const { app, raw } = await socialApp(service);
    const seen: string[] = [...config.secrets];
    for (const provider of ['github', 'google', 'github'] as const) {
      const code = runtimeSecret('auth-code');
      seen.push(code);
      const start = await app.inject({ url: `/login/${provider}` });
      const location = new URL(String(start.headers['location']));
      const state = location.searchParams.get('state') ?? '';
      providers.nonce = location.searchParams.get('nonce') ?? '';
      seen.push(state, cookieOf(start.headers['set-cookie']).split('=')[1] ?? '');
      const res = await app.inject({
        url: `/login/${provider}/callback?code=${code}&state=${state}`,
        headers: { cookie: cookieOf(start.headers['set-cookie']) },
      });
      for (const secret of seen) expect(res.body).not.toContain(secret);
      // The third login fails at GitHub; its page and log line hold nothing either.
      providers.github.tokenStatus = 500;
    }
    // Every provider response the fakes produced (access tokens, ID tokens) was secret too.
    const tokens = providers.calls.flatMap((call) =>
      call.authorization === undefined ? [] : [call.authorization.slice('Bearer '.length)],
    );
    expect(tokens.length).toBeGreaterThan(0);
    const log = raw();
    expect(log).toContain('auth.social_login');
    expect(log).toContain('auth.social_login_failed');
    for (const secret of [...seen, ...tokens, 'octo@example.test', 'gina@example.test'])
      expect(log).not.toContain(secret);
    await app.close();
  });
});

describe.runIf(ADMIN_URL !== undefined)('the database after a login on Postgres 16', () => {
  let t: TestDatabase;
  let db: Kysely<SocialDatabase>;
  beforeAll(async () => {
    t = await migratedDatabase();
    db = t.db as unknown as Kysely<SocialDatabase>;
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  it('keeps provider, subject, user and time only: no token or code anywhere (acceptance 7)', async () => {
    const columns = await sql<{ name: string }>`
      select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = 'identities' order by ordinal_position
    `.execute(db);
    expect(columns.rows.map((r) => r.name)).toEqual([
      'provider',
      'subject',
      'user_id',
      'created_at',
    ]);

    const providers = fakeProviders();
    const service = new SocialLoginService({
      config: testConfig(),
      users: new UserService({ db: t.db, newId, now: () => new Date() }),
      identities: createIdentityRepo(db),
      fetch: providers.fetch,
    });
    const code = runtimeSecret('auth-code');
    for (const provider of ['github', 'google'] as const) {
      const login = await begun(service, providers, provider);
      await service.complete(provider, { code, state: login.state }, login.cookie);
    }
    const tokens = providers.calls.flatMap((call) =>
      call.authorization === undefined ? [] : [call.authorization.slice('Bearer '.length)],
    );
    // Every row of every table, as text.
    const tables = await sql<{
      name: string;
    }>`select tablename as name from pg_tables where schemaname = 'public'`.execute(db);
    let dump = '';
    for (const { name } of tables.rows) {
      dump += JSON.stringify((await sql`select * from ${sql.table(name)}`.execute(db)).rows);
    }
    for (const secret of [code, ...tokens]) expect(dump).not.toContain(secret);
    expect(dump).toContain('4242'); // the GitHub subject is kept: that is the point
  });
});

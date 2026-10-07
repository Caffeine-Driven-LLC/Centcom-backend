/**
 * The token store on Postgres 16 (B014; DATABASE_URL, CI's integration job): only hashes are kept,
 * a link is used once (two concurrent uses: one winner), by its browser, before it expires, and
 * an invalidated link never works; then the whole flow with B013's UserService: a new address
 * signs up, a second link signs into the same account.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { MagicLinkDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { returnToPolicy } from '../../../../src/modules/auth/return-to.js';
import { MagicLinkService } from '../../../../src/modules/auth/magic-link/service.js';
import { createLoginTokenStore } from '../../../../src/modules/auth/magic-link/store.js';
import { UserService } from '../../../../src/modules/users/index.js';
import { createMemoryRedis } from '@centcom/core';
import { ADMIN_URL, migratedDatabase, newId, type TestDatabase } from '../../users/helpers.js';
import { ALLOWLIST, BASE_URL, capturingMailer, tokenOf } from './helpers.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');

describe.runIf(ADMIN_URL !== undefined)('login tokens on Postgres 16', () => {
  let t: TestDatabase;
  let db: Kysely<MagicLinkDatabase>;
  beforeAll(async () => {
    t = await migratedDatabase(5);
    db = t.db as unknown as Kysely<MagicLinkDatabase>;
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  it('keeps hashes only, and uses a link once, by its browser, before it expires', async () => {
    const store = createLoginTokenStore(db);
    const [token, nonce] = [secret(), secret()];
    const now = new Date();
    await store.insert({
      tokenHash: sha256(token),
      nonceHash: sha256(nonce),
      email: 'ada@example.test',
      returnTo: ALLOWLIST[0] ?? '',
      expiresAt: new Date(now.getTime() + 900_000),
    });
    const rows = await db.selectFrom('login_tokens').selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(nonce);
    expect(await store.consume(sha256(token), sha256(secret()), now)).toBeNull();
    expect(
      await store.consume(sha256(token), sha256(nonce), new Date(now.getTime() + 900_000)),
    ).toBeNull();
    expect(await store.consume(sha256(token), sha256(nonce), now)).toEqual({
      email: 'ada@example.test',
      returnTo: ALLOWLIST[0],
    });
    expect(await store.consume(sha256(token), sha256(nonce), now)).toBeNull();
  });

  it('lets exactly one of two concurrent uses win, and never an invalidated link', async () => {
    const store = createLoginTokenStore(db);
    const [token, nonce, other] = [secret(), secret(), secret()];
    const now = new Date();
    for (const value of [token, other]) {
      await store.insert({
        tokenHash: sha256(value),
        nonceHash: sha256(nonce),
        email: 'grace@example.test',
        returnTo: ALLOWLIST[0] ?? '',
        expiresAt: new Date(now.getTime() + 900_000),
      });
    }
    const uses = await Promise.all([
      store.consume(sha256(token), sha256(nonce), now),
      store.consume(sha256(token), sha256(nonce), now),
    ]);
    expect(uses.filter((u) => u !== null)).toHaveLength(1);
    await store.invalidate(sha256(other), now);
    expect(await store.consume(sha256(other), sha256(nonce), now)).toBeNull();
  });

  it('signs a new address up, and a second link into the same account', async () => {
    const mailer = capturingMailer();
    const service = new MagicLinkService({
      store: createLoginTokenStore(db),
      mailer,
      users: new UserService({ db: t.db, newId, now: () => new Date() }),
      rateLimit: createMemoryRedis().rateLimit,
      returnTo: returnToPolicy(ALLOWLIST),
      baseUrl: BASE_URL,
    });
    const nonce = secret();
    await service.request('New.User@Example.TEST', { nonce, locale: 'en' });
    await service.request('new.user@example.test', { nonce, locale: 'en' });
    await service.idle();
    const [first, second] = await Promise.all(
      mailer.sent.map(({ link }) => service.consume(tokenOf(link), nonce)),
    );
    expect(first?.userId).toMatch(/^usr_/);
    expect(second?.userId).toBe(first?.userId);
    const users = await t.db
      .selectFrom('users')
      .select('email')
      .where('email', '=', 'new.user@example.test')
      .execute();
    expect(users).toHaveLength(1);
  });
});

/**
 * The Postgres AccountStore (B022, card test etag.test.ts): exact microsecond versions, the
 * compare-and-set update (one winner of two concurrent writers, acceptance 8, also over HTTP),
 * deleted users invisible, membership checks and the personal workspace B013 creates. Against a
 * real Postgres 16 (DATABASE_URL, CI's integration job); the ETag format is checked everywhere.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeEtag, ifMatchAccepts, parseIfMatch } from '../../src/modules/me/etag.js';
import { createAccountStore, MeService } from '../../src/modules/me/service.js';
import { UserService } from '../../src/modules/users/index.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../modules/users/helpers.js';
import { as, headerCaller, recordingAudit } from './me-helpers.js';
import { fastify } from 'fastify';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { meRoutes } from '../../src/routes/me.js';
import { captureLogger } from '../helpers.js';

describe('ETags', () => {
  it('name a version strongly, and If-Match accepts what it lists, * or nothing at all', () => {
    expect(computeEtag({ version: '1791374400123456' })).toBe('"v1791374400123456"');
    expect(() => computeEtag({ version: '12a' })).toThrow(TypeError);
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('*')).toEqual({ any: true });
    expect(parseIfMatch('"v1", W/"v2", "v3" , "x4", junk')).toEqual({
      any: false,
      versions: ['1', '3'],
    });
    expect(parseIfMatch(['"v1"', '"v2"'])).toEqual({ any: false, versions: ['1', '2'] });
    expect(ifMatchAccepts(undefined, '5')).toBe(true);
    expect(ifMatchAccepts({ any: true }, '5')).toBe(true);
    expect(ifMatchAccepts({ any: false, versions: ['4'] }, '5')).toBe(false);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the account store on Postgres 16', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await migratedDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  const signUp = async (email: string): Promise<string> =>
    (await new UserService({ db: t.db, newId, now: () => new Date() }).getOrCreateByEmail(email))
      .user.id;

  it('finds a user with an exact microsecond version that every update moves', async () => {
    const store = createAccountStore(t.db);
    const userId = await signUp('versions@example.test');
    const first = await store.find(userId);
    expect(first?.version).toMatch(/^\d{16}$/);
    const updated = await store.update(userId, { locale: 'fr' }, [first?.version ?? '']);
    expect(updated.kind).toBe('updated');
    const second = updated.kind === 'updated' ? updated.user : undefined;
    expect(second?.user.locale).toBe('fr');
    expect(second?.version).not.toBe(first?.version);
    expect((await store.find(userId))?.version).toBe(second?.version);
    // Unconditional when no version is given; stale with an old one; missing for nobody.
    expect((await store.update(userId, { locale: 'de' })).kind).toBe('updated');
    expect((await store.update(userId, { locale: 'it' }, [first?.version ?? ''])).kind).toBe(
      'stale',
    );
    expect((await store.update(userId, { locale: 'it' }, [])).kind).toBe('stale');
    expect((await store.update(newId('usr'), { locale: 'it' })).kind).toBe('missing');
    expect((await store.find(userId))?.user.locale).toBe('de');
  });

  it('lets exactly one of two concurrent compare-and-set updates with one version win (acceptance 8)', async () => {
    const store = createAccountStore(t.db);
    const userId = await signUp('race@example.test');
    const version = (await store.find(userId))?.version ?? '';
    const outcomes = await Promise.all([
      store.update(userId, { display_name: 'One' }, [version]),
      store.update(userId, { display_name: 'Two' }, [version]),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['stale', 'updated']);
  });

  it('does the same over HTTP: two PATCHes with one If-Match give 200 and 412 (acceptance 8)', async () => {
    const userId = await signUp('http-race@example.test');
    const captured = captureLogger();
    const me = new MeService({ store: createAccountStore(t.db), audit: recordingAudit() });
    const app = fastify({ logger: false });
    await app.register(requestContextPlugin, { logger: captured.logger });
    await app.register(errorHandlerPlugin, { logger: captured.logger });
    await app.register(meRoutes, { me, caller: headerCaller });
    await app.ready();
    try {
      const etag = String(
        (await app.inject({ url: '/v1/me', headers: as(userId) })).headers['etag'],
      );
      const results = await Promise.all(
        ['Left', 'Right'].map((name) =>
          app.inject({
            method: 'PATCH',
            url: '/v1/me',
            headers: as(userId, { 'if-match': etag }),
            payload: { display_name: name },
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
      const after = await app.inject({ url: '/v1/me', headers: as(userId) });
      expect(after.json()).toMatchObject({
        active_workspace: expect.stringMatching(/^wsp_/) as string,
        plan: 'free',
        ent: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('hides deleted users and shows pending deletions', async () => {
    const store = createAccountStore(t.db);
    const gone = await signUp('gone@example.test');
    const leaving = await signUp('leaving@example.test');
    await t.db.updateTable('users').set({ status: 'deleted' }).where('id', '=', gone).execute();
    await t.db
      .updateTable('users')
      .set({ status: 'pending_deletion', deletion_requested_at: new Date() })
      .where('id', '=', leaving)
      .execute();
    expect(await store.find(gone)).toBeNull();
    expect((await store.update(gone, { locale: 'fr' })).kind).toBe('missing');
    expect((await store.find(leaving))?.user.status).toBe('pending_deletion');
  });

  it('checks membership of live workspaces, and finds the personal workspace B013 made', async () => {
    const store = createAccountStore(t.db);
    const userId = await signUp('member@example.test');
    const personal = await store.personalWorkspace(userId);
    expect(personal).toMatch(/^wsp_/);
    expect(await store.isMember(userId, personal ?? '')).toBe(true);
    const other = await signUp('other@example.test');
    const othersWorkspace = (await store.personalWorkspace(other)) ?? '';
    expect(await store.isMember(userId, othersWorkspace)).toBe(false);
    // A later workspace the user owns does not replace the personal one.
    const later = newId('wsp');
    await t.db
      .insertInto('workspaces')
      .values({
        id: later,
        name: 'Later',
        slug: `later-${later.slice(-8).toLowerCase()}`,
        created_by: userId,
      })
      .execute();
    await t.db
      .insertInto('memberships')
      .values({ id: newId('mem'), workspace_id: later, user_id: userId, role: 'owner' })
      .execute();
    expect(await store.personalWorkspace(userId)).toBe(personal);
    // Soft-deleted: no longer a membership, no longer the personal workspace.
    await t.db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', personal ?? '')
      .execute();
    expect(await store.isMember(userId, personal ?? '')).toBe(false);
    expect(await store.personalWorkspace(userId)).toBe(later);
  });
});

/**
 * ETag and If-Match (B066 acceptance 6, failure mode "concurrent PUTs"): GET answers `"v0"` before
 * any write; each PUT moves the ETag on by one and GET then shows it; a PUT with a stale If-Match
 * is 412 `precondition_failed` and changes nothing; `*`, the current ETag, or a list holding it is
 * accepted, a weak or malformed one never is; `"v0"` writes only while there is no row. Without
 * If-Match the last write wins. On Postgres 16 (DATABASE_URL), the same on real rows, and 10
 * concurrent PUTs get versions 1 to 10, one each.
 */
import type { NotificationPrefDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createPreferencesRepository } from '../../../src/modules/notifications/preferences/repository.js';
import { parsePreferences } from '../../../src/modules/notifications/preferences/schema.js';
import { PreferencesService } from '../../../src/modules/notifications/preferences/service.js';
import { parseIfMatch } from '../../../src/modules/me/etag.js';
import { pgUser } from '../inbox/helpers.js';
import {
  ADMIN_URL,
  memoryPreferences,
  migratedDatabase,
  newId,
  prefsApp,
  validBody,
} from './helpers.js';

const URL = '/v1/notification-preferences';

describe('ETag and If-Match', () => {
  it('moves the ETag on with each PUT, and refuses a stale If-Match with 412', async () => {
    const user = newId('usr');
    const memory = memoryPreferences();
    const { app, bearerFor } = await prefsApp(memory.repository);
    const headers = await bearerFor(user);
    const get = async () => app.inject({ method: 'GET', url: URL, headers });
    const put = async (body: Record<string, unknown>, ifMatch?: string) =>
      app.inject({
        method: 'PUT',
        url: URL,
        headers: { ...headers, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
        payload: body,
      });

    expect((await get()).headers['etag']).toBe('"v0"');
    const first = await put(validBody(), '"v0"');
    expect(first.statusCode).toBe(200);
    expect(first.headers['etag']).toBe('"v1"');
    expect((await get()).headers['etag']).toBe('"v1"');

    const second = await put(validBody({ quiet_hours: { enabled: false } }), '"v1"');
    expect(second.headers['etag']).toBe('"v2"');

    const stale = await put(validBody(), '"v1"');
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('precondition_failed');
    const now = await get();
    expect(now.headers['etag']).toBe('"v2"');
    expect(now.json<{ quiet_hours: { enabled: boolean } }>().quiet_hours.enabled).toBe(false);

    expect((await put(validBody(), '"v0"')).statusCode).toBe(412);
    expect((await put(validBody(), 'W/"v2"')).statusCode).toBe(412);
    expect((await put(validBody(), 'v2')).statusCode).toBe(412);
    expect((await put(validBody(), '"v1", "v2"')).headers['etag']).toBe('"v3"');
    expect((await put(validBody(), '*')).headers['etag']).toBe('"v4"');
    expect((await put(validBody())).headers['etag']).toBe('"v5"');
    await app.close();
  });

  it('lets the last write win without If-Match', async () => {
    const user = newId('usr');
    const memory = memoryPreferences();
    const { app, bearerFor } = await prefsApp(memory.repository);
    const headers = await bearerFor(user);
    const bodies = ['Europe/Berlin', 'Asia/Tokyo', 'America/New_York'].map((timezone) =>
      validBody({ quiet_hours: { enabled: true, start: '22:00', end: '07:00', timezone } }),
    );
    const responses = await Promise.all(
      bodies.map((payload) => app.inject({ method: 'PUT', url: URL, headers, payload })),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.headers['etag']).sort()).toEqual(['"v1"', '"v2"', '"v3"']);
    const last = responses.find((r) => r.headers['etag'] === '"v3"');
    const now = await app.inject({ method: 'GET', url: URL, headers });
    expect(now.json()).toEqual(last?.json());
    await app.close();
  });
});

describe.runIf(ADMIN_URL !== undefined)('preferences on Postgres 16', () => {
  it('reads the defaults, writes whole documents, and compares versions in SQL', async () => {
    const t = await migratedDatabase(12);
    try {
      const db = t.db as unknown as Kysely<NotificationPrefDb>;
      const service = new PreferencesService({ repository: createPreferencesRepository(db) });
      const user = await pgUser(t.db);
      const other = await pgUser(t.db);

      expect(await service.read(user)).toMatchObject({ version: 0 });
      const doc = parsePreferences(validBody());
      expect(await service.replace(user, doc, parseIfMatch('"v1"'))).toBe('stale');
      expect(await service.replace(user, doc, parseIfMatch('"v0"'))).toMatchObject({ version: 1 });
      expect(await service.replace(user, doc, parseIfMatch('"v0"'))).toBe('stale');
      expect(await service.replace(user, doc, parseIfMatch('"v1"'))).toMatchObject({ version: 2 });
      expect(await service.replace(user, doc, parseIfMatch('"v1"'))).toBe('stale');
      expect(await service.replace(user, doc, parseIfMatch('*'))).toMatchObject({ version: 3 });
      expect(await service.read(user)).toEqual({ prefs: doc, version: 3 });
      expect(await service.read(other)).toMatchObject({ version: 0 });

      const row = await db
        .selectFrom('notification_pref')
        .selectAll()
        .where('user_id', '=', user)
        .executeTakeFirstOrThrow();
      expect(Object.keys(row.doc).sort()).toEqual(['channels', 'quiet_hours']);
      expect(row.version).toBe(3);

      // Ten writers at once without If-Match: each gets its own version, the last one wins.
      const fresh = await pgUser(t.db);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.replace(fresh, doc)),
      );
      const versions = results.map((r) => (r === 'stale' ? 0 : r.version)).sort((a, b) => a - b);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Ten writers at once on the same If-Match: exactly one wins.
      const raced = await Promise.all(
        Array.from({ length: 10 }, () => service.replace(fresh, doc, parseIfMatch('"v10"'))),
      );
      expect(raced.filter((r) => r !== 'stale')).toHaveLength(1);
    } finally {
      await t.drop();
    }
  }, 60_000);
});

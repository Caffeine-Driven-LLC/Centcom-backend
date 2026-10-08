/**
 * Validation and invariants (B066 acceptance 2, 3, 5 and 7, guardrails, failure modes): a PUT with
 * an unknown category or channel (`sms`), a switch that is not a boolean, the card's array shape,
 * a missing part, a malformed time, equal start and end, or a zone that is not an IANA name (an
 * offset such as `+01:00` included) is 422 with each problem's pointer; unknown fields are ignored
 * and not stored; turning quiet hours on needs start, end and timezone; the zone is stored in its
 * canonical spelling; categories and switches left out take their defaults; `inbox` comes back on
 * for `billing_issue` and `security_alert`; a body over 8 KiB is 413; the routes are
 * rate-limited (B023) and for users with `profile` only. A stored document of an older shape is
 * read leniently with a warning, never a 500; a database timeout is 503.
 */
import { describe, expect, it } from 'vitest';
import {
  parsePreferences,
  PREFERENCES_MAX_BYTES,
  readStoredPreferences,
} from '../../../src/modules/notifications/preferences/schema.js';
import { memoryPreferences, newId, prefsApp, validBody } from './helpers.js';

type Problem = { code: string; errors?: { pointer: string; code: string }[] };

async function put(body: unknown, userId = newId('usr')) {
  const memory = memoryPreferences();
  const { app, bearerFor } = await prefsApp(memory.repository);
  const response = await app.inject({
    method: 'PUT',
    url: '/v1/notification-preferences',
    headers: await bearerFor(userId),
    payload: body as Record<string, unknown>,
  });
  await app.close();
  return { response, memory };
}

const pointersOf = (body: Problem): string[] => (body.errors ?? []).map((e) => e.pointer);

describe('PUT /v1/notification-preferences validation', () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    [
      'an unknown category',
      { channels: { coffee_ready: { inbox: true } } },
      ['/channels/coffee_ready'],
    ],
    [
      'the channel sms',
      { channels: { approval_needed: { sms: true } } },
      ['/channels/approval_needed/sms'],
    ],
    [
      'a switch that is not a boolean',
      { channels: { approval_needed: { push: 'yes' } } },
      ['/channels/approval_needed/push'],
    ],
    [
      "the card's array shape",
      { channels: { approval_needed: ['inbox', 'sms'] } },
      ['/channels/approval_needed'],
    ],
    ['channels that are not an object', { channels: [] }, ['/channels']],
    ['no channels', { channels: undefined }, ['/channels']],
    ['no quiet hours', { quiet_hours: undefined }, ['/quiet_hours']],
    [
      'quiet hours without enabled',
      { quiet_hours: { start: '22:00', end: '07:00', timezone: 'Europe/Berlin' } },
      ['/quiet_hours/enabled'],
    ],
    [
      'equal start and end',
      { quiet_hours: { enabled: true, start: '22:00', end: '22:00', timezone: 'Europe/Berlin' } },
      ['/quiet_hours/end'],
    ],
    [
      'a time past 23:59',
      { quiet_hours: { enabled: true, start: '24:00', end: '07:00', timezone: 'Europe/Berlin' } },
      ['/quiet_hours/start'],
    ],
    [
      'a time without two digits',
      { quiet_hours: { enabled: true, start: '22:00', end: '7:00', timezone: 'Europe/Berlin' } },
      ['/quiet_hours/end'],
    ],
    [
      'quiet hours on without times or zone',
      { quiet_hours: { enabled: true } },
      ['/quiet_hours/start', '/quiet_hours/end', '/quiet_hours/timezone'],
    ],
    [
      'allow_approval_needed that is not a boolean',
      { quiet_hours: { enabled: false, allow_approval_needed: 1 } },
      ['/quiet_hours/allow_approval_needed'],
    ],
  ])('refuses %s with 422', async (_case, change, pointers) => {
    const { response, memory } = await put(validBody(change));
    expect(response.statusCode).toBe(422);
    const body = response.json<Problem>();
    expect(body.code).toBe('validation_failed');
    expect(pointersOf(body).sort()).toEqual([...pointers].sort());
    expect(memory.saves).toEqual([]);
  });

  it.each([
    ['Mars/Base'],
    ['+01:00'],
    ['-0500'],
    ['GMT+1'],
    ['UTC+2'],
    [''],
    ['Europe/Berlin '],
    ['A'.repeat(65)],
    [3600],
  ])('refuses the time zone %j with 422', async (timezone) => {
    const { response } = await put(
      validBody({ quiet_hours: { enabled: true, start: '22:00', end: '07:00', timezone } }),
    );
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response.json<Problem>())).toEqual(['/quiet_hours/timezone']);
  });

  it('refuses a body that is not an object, pointing at the root', () => {
    for (const body of [null, [], 'prefs', 3]) {
      try {
        parsePreferences(body);
        expect.unreachable();
      } catch (err) {
        expect((err as Problem).code).toBe('validation_failed');
        expect(pointersOf(err as Problem)).toEqual(['']);
      }
    }
  });

  it('stores the zone in its canonical spelling, and ignores unknown fields without storing them', async () => {
    const { response, memory } = await put({
      ...validBody({
        quiet_hours: {
          enabled: true,
          start: '22:00',
          end: '07:00',
          timezone: 'europe/berlin',
          snooze: 5,
        },
      }),
      theme: 'dark',
      device_name: 'Phone',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['channels', 'quiet_hours']);
    expect(body['quiet_hours']).toEqual({
      enabled: true,
      start: '22:00',
      end: '07:00',
      timezone: 'Europe/Berlin',
      allow_approval_needed: false,
    });
    const stored = JSON.stringify(memory.saves[0]?.doc);
    for (const text of ['theme', 'dark', 'device_name', 'Phone', 'snooze']) {
      expect(stored).not.toContain(text);
    }
  });

  it('fills left-out categories and switches with their defaults', async () => {
    const { response } = await put(
      validBody({ channels: { mention: { push: true } }, quiet_hours: { enabled: false } }),
    );
    const body = response.json<{ channels: Record<string, Record<string, boolean>> }>();
    expect(Object.keys(body.channels)).toHaveLength(14);
    expect(body.channels['mention']).toEqual({ inbox: true, push: true, email: false, os: false });
    expect(body.channels['approval_needed']).toEqual({
      inbox: true,
      push: true,
      email: false,
      os: true,
    });
  });

  it('keeps inbox on for billing_issue and security_alert, whatever the body says', async () => {
    const { response, memory } = await put(
      validBody({
        channels: {
          billing_issue: { inbox: false, email: false },
          security_alert: { inbox: false, push: true },
          mention: { inbox: false },
        },
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{ channels: Record<string, Record<string, boolean>> }>();
    expect(body.channels['billing_issue']).toEqual({
      inbox: true,
      push: false,
      email: false,
      os: false,
    });
    expect(body.channels['security_alert']).toEqual({
      inbox: true,
      push: true,
      email: false,
      os: false,
    });
    expect(body.channels['mention']?.inbox).toBe(false);
    const stored = memory.saves[0]?.doc as { channels: Record<string, Record<string, boolean>> };
    expect(stored.channels['billing_issue']?.inbox).toBe(true);
    expect(stored.channels['security_alert']?.inbox).toBe(true);
  });

  it('accepts quiet hours that are off with or without a window', async () => {
    expect((await put(validBody({ quiet_hours: { enabled: false } }))).response.statusCode).toBe(
      200,
    );
    const kept = await put(
      validBody({
        quiet_hours: { enabled: false, start: '13:00', end: '14:00', timezone: 'Asia/Tokyo' },
      }),
    );
    expect(kept.response.json<{ quiet_hours: unknown }>().quiet_hours).toEqual({
      enabled: false,
      start: '13:00',
      end: '14:00',
      timezone: 'Asia/Tokyo',
      allow_approval_needed: false,
    });
  });

  it(`refuses a body over ${PREFERENCES_MAX_BYTES} bytes with 413`, async () => {
    const body = JSON.stringify({ ...validBody(), padding: 'x'.repeat(PREFERENCES_MAX_BYTES) });
    const memory = memoryPreferences();
    const { app, bearerFor } = await prefsApp(memory.repository);
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers: { ...(await bearerFor(newId('usr'))), 'content-type': 'application/json' },
      payload: body,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<Problem>().code).toBe('payload_too_large');
    expect(memory.saves).toEqual([]);
    await app.close();
  });
});

describe('who may use the preferences', () => {
  it.each([['GET'], ['PUT']] as const)(
    '%s: 403 for API keys and tokens without profile, 401 without a token',
    async (method) => {
      const { app, bearerFor } = await prefsApp();
      const url = '/v1/notification-preferences';
      const payload = method === 'PUT' ? validBody() : undefined;
      const key = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer cen_live_${'k'.repeat(32)}` },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(key.statusCode).toBe(403);
      const scoped = await app.inject({
        method,
        url,
        headers: await bearerFor(newId('usr'), ['sessions:read']),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(scoped.statusCode).toBe(403);
      expect(
        (await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }))
          .statusCode,
      ).toBe(401);
      await app.close();
    },
  );

  it('counts both routes against the caller’s rate limit (429 past it)', async () => {
    const user = newId('usr');
    const { app, bearerFor } = await prefsApp(memoryPreferences().repository, { rateLimit: 3 });
    const headers = { ...(await bearerFor(user)), 'x-test-user': user };
    const codes: number[] = [];
    for (const method of ['GET', 'PUT', 'GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: '/v1/notification-preferences',
        headers,
        ...(method === 'PUT' ? { payload: validBody() } : {}),
      });
      codes.push(response.statusCode);
      expect(response.headers['ratelimit-limit']).toBeDefined();
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    await app.close();
  });
});

describe('stored documents and failures', () => {
  it('reads a stored document of an older shape leniently, with a warning, never a 500', async () => {
    const user = newId('usr');
    const memory = memoryPreferences({
      [user]: {
        version: 4,
        doc: {
          channels: {
            approval_needed: ['inbox', 'push'],
            mention: { push: true, sms: true },
            retired_category: { inbox: true },
          },
          quiet_hours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Old/Zone' },
        },
      },
    });
    const { app, bearerFor, captured } = await prefsApp(memory.repository);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/notification-preferences',
      headers: await bearerFor(user),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"v4"');
    const body = response.json<{
      channels: Record<string, Record<string, boolean>>;
      quiet_hours: { enabled: boolean };
    }>();
    expect(body.channels['mention']).toEqual({ inbox: true, push: true, email: false, os: false });
    expect(body.channels['approval_needed']).toEqual({
      inbox: true,
      push: true,
      email: false,
      os: true,
    });
    expect(body.quiet_hours.enabled).toBe(false);
    const warning = captured.lines().find((l) => l['msg'] === 'notification_prefs.stored_invalid');
    expect(warning?.['user_id']).toBe(user);
    expect(warning?.['dropped']).toEqual([
      '/channels/approval_needed',
      '/channels/mention/sms',
      '/channels/retired_category',
      '/quiet_hours/timezone',
    ]);
    expect(JSON.stringify(warning)).not.toContain('Old/Zone');
    await app.close();
  });

  it('reads anything at all without throwing', () => {
    for (const doc of [null, 7, 'x', [], {}, { channels: null, quiet_hours: [] }]) {
      const { prefs, issues } = readStoredPreferences(doc);
      expect(Object.keys(prefs.channels)).toHaveLength(14);
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it('answers 503 with retry_after_s when the database times out', async () => {
    const memory = memoryPreferences({}, () =>
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const { app, bearerFor } = await prefsApp(memory.repository);
    const headers = await bearerFor(newId('usr'));
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: '/v1/notification-preferences',
        headers,
        ...(method === 'PUT' ? { payload: validBody() } : {}),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ retry_after_s: number }>().retry_after_s).toBeGreaterThan(0);
    }
    await app.close();
  });
});

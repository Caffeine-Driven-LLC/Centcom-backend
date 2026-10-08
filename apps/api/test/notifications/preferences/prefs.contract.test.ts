/**
 * Agreement with B063's routing (B066 acceptance 3, card test prefs.contract.test.ts): the service
 * is B063's `PreferencesPort`, and its defaults route every category exactly as "no preferences"
 * does, quiet or not, at every priority; whatever a user saves, `security_alert` and
 * `billing_issue` reach the inbox and quiet hours (on now, by `isQuietNow`) leave their channels
 * alone, while they drop push and os elsewhere unless a high approval_needed is allowed through.
 * Documents the routes return validate as `api/NotificationPreferences`.
 */
import { validate } from '@centcom/contracts';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_PRIORITIES } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { PreferencesPort } from '../../../src/modules/notifications/dispatcher/ports.js';
import { decideChannels } from '../../../src/modules/notifications/dispatcher/routing.js';
import { isQuietNow } from '../../../src/modules/notifications/preferences/quiet-hours.js';
import { parsePreferences } from '../../../src/modules/notifications/preferences/schema.js';
import { PreferencesService } from '../../../src/modules/notifications/preferences/service.js';
import { memoryPreferences, newId, prefsApp, validBody } from './helpers.js';

const sorted = (set: Set<string>): string[] => [...set].sort();
/** 23:30 in Berlin, inside the 22:00 to 07:00 window of `validBody`. */
const NIGHT = new Date('2026-07-14T21:30:00Z');

describe("B063's routing with these preferences", () => {
  it('routes every category on the defaults exactly as with no preferences', async () => {
    const port: PreferencesPort = new PreferencesService({
      repository: memoryPreferences().repository,
    });
    const defaults = await port.get(newId('usr'));
    expect(defaults).not.toBeNull();
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const priority of NOTIFICATION_PRIORITIES) {
        for (const quiet of [false, true]) {
          expect(
            sorted(decideChannels({ category, priority, prefs: defaults, quiet })),
            `${category} ${priority} ${quiet}`,
          ).toEqual(sorted(decideChannels({ category, priority, prefs: null, quiet })));
        }
      }
    }
  });

  it('keeps security_alert and billing_issue in the inbox and untouched by quiet hours', async () => {
    const user = newId('usr');
    const memory = memoryPreferences();
    const service = new PreferencesService({ repository: memory.repository });
    const everythingOn = { inbox: false, push: true, email: true, os: true };
    await service.replace(
      user,
      parsePreferences(
        validBody({
          channels: {
            security_alert: everythingOn,
            billing_issue: everythingOn,
            mention: everythingOn,
            approval_needed: everythingOn,
          },
          quiet_hours: {
            enabled: true,
            start: '22:00',
            end: '07:00',
            timezone: 'Europe/Berlin',
            allow_approval_needed: true,
          },
        }),
      ),
    );
    const prefs = await service.get(user);
    const quiet = isQuietNow(prefs, NIGHT);
    expect(quiet).toBe(true);
    const route = (
      category: (typeof NOTIFICATION_CATEGORIES)[number],
      priority = 'normal' as const,
    ) => sorted(decideChannels({ category, priority, prefs, quiet }));
    for (const category of ['security_alert', 'billing_issue'] as const) {
      expect(route(category)).toEqual(['email', 'inbox', 'os', 'push']);
    }
    expect(route('mention')).toEqual(['email']);
    expect(route('approval_needed')).toEqual(['email']);
    expect(
      sorted(decideChannels({ category: 'approval_needed', priority: 'high', prefs, quiet })),
    ).toEqual(['email', 'os', 'push']);
  });

  it('returns documents that validate as api/NotificationPreferences', async () => {
    const user = newId('usr');
    const { app, bearerFor } = await prefsApp();
    const headers = await bearerFor(user);
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences',
      headers,
      payload: validBody(),
    });
    expect(validate('api/NotificationPreferences', put.json()).ok).toBe(true);
    const get = await app.inject({ method: 'GET', url: '/v1/notification-preferences', headers });
    expect(validate('api/NotificationPreferences', get.json()).ok).toBe(true);
    expect(get.json()).toEqual(put.json());
    await app.close();
  });
});

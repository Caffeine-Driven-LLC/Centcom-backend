/**
 * Defaults (B066 acceptance 1, guardrail "defaults are code constants tested against the
 * contract"): a user who never saved preferences gets every one of the 14 CT-API-NOTIFY categories
 * with the CT-NOTIF-PAYLOAD defaults (approval_needed → inbox, push, os; billing_issue → inbox,
 * email; the rest → inbox) and quiet hours off, at ETag `"v0"`, valid as
 * `api/NotificationPreferences`; the categories are the contract's (CT-NOTIF-PAYLOAD's 15 less
 * `trial_ending`, which has no switches); the defaults agree with B063's `defaultChannels`; and
 * nothing is written to read them.
 */
import { validate } from '@centcom/contracts';
import { NOTIFICATION_CATEGORIES } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { defaultChannels } from '../../../src/modules/notifications/dispatcher/routing.js';
import {
  defaultPreferences,
  PREFERENCE_CATEGORIES,
  PREFERENCE_CHANNELS,
} from '../../../src/modules/notifications/preferences/schema.js';
import { memoryPreferences, newId, prefsApp } from './helpers.js';

/** CT-NOTIF-PAYLOAD "Defaults", written out. */
const CONTRACT_DEFAULTS: Record<string, string[]> = {
  approval_needed: ['inbox', 'os', 'push'],
  billing_issue: ['email', 'inbox'],
};

const on = (switches: Record<string, boolean>): string[] =>
  Object.entries(switches)
    .filter(([, value]) => value)
    .map(([channel]) => channel)
    .sort();

describe('defaults', () => {
  it('answers GET for a user with no row with the contract defaults of all 14 categories', async () => {
    const memory = memoryPreferences();
    const { app, bearerFor } = await prefsApp(memory.repository);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/notification-preferences',
      headers: await bearerFor(newId('usr')),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"v0"');
    expect(response.headers['cache-control']).toBe('private, no-cache');
    const body = response.json<{
      channels: Record<string, Record<string, boolean>>;
      quiet_hours: { enabled: boolean };
    }>();
    expect(Object.keys(body.channels)).toHaveLength(14);
    for (const [category, switches] of Object.entries(body.channels)) {
      expect(Object.keys(switches).sort()).toEqual([...PREFERENCE_CHANNELS].sort());
      expect(on(switches), category).toEqual(CONTRACT_DEFAULTS[category] ?? ['inbox']);
    }
    expect(body.quiet_hours.enabled).toBe(false);
    expect(validate('api/NotificationPreferences', body).ok).toBe(true);
    expect(memory.saves).toEqual([]);
    await app.close();
  });

  it("lists the contract's categories: CT-NOTIF-PAYLOAD's less trial_ending", () => {
    expect([...PREFERENCE_CATEGORIES].sort()).toEqual(
      NOTIFICATION_CATEGORIES.filter((c) => c !== 'trial_ending').sort(),
    );
    // Each category is one api/NotificationPreferences accepts as a key.
    for (const category of PREFERENCE_CATEGORIES) {
      const doc = { channels: { [category]: { inbox: true } }, quiet_hours: { enabled: false } };
      expect(validate('api/NotificationPreferences', doc).ok, category).toBe(true);
    }
  });

  it("agrees with B063's defaultChannels for every category", () => {
    const defaults = defaultPreferences();
    for (const category of PREFERENCE_CATEGORIES) {
      expect(on(defaults.channels[category])).toEqual([...defaultChannels(category)].sort());
    }
  });

  it('hands out a fresh copy each time', () => {
    const first = defaultPreferences();
    first.channels.mention.push = true;
    first.quiet_hours.enabled = true;
    const second = defaultPreferences();
    expect(second.channels.mention.push).toBe(false);
    expect(second.quiet_hours.enabled).toBe(false);
  });
});

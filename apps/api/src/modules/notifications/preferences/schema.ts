/**
 * The notification preference document (B066, CT-API-NOTIFY `NotificationPreferences`):
 * `{channels: {<category>: {inbox?, push?, email?, os?}}, quiet_hours: {enabled, start?, end?,
 * timezone?, allow_approval_needed?}}`.
 *
 * - Defaults (CT-NOTIF-PAYLOAD): approval_needed → inbox, push, os; billing_issue → inbox, email;
 *   every other category → inbox; quiet hours off. They are code constants.
 * - A PUT body must be such a document. Unknown categories and channels, non-boolean switches,
 *   malformed times, equal start and end, and a zone that is not an IANA name are 422, each with
 *   its pointer (`/channels/approval_needed/sms`). Unknown fields elsewhere are ignored and not
 *   kept. Turning quiet hours on needs start, end and timezone.
 * - What is stored and returned is complete: every category with all four switches, categories
 *   and switches left out taking their defaults. `security_alert` and `billing_issue` always keep
 *   `inbox` on, whatever the body says.
 * - A stored document that no longer validates (an older shape) is read leniently: its valid parts
 *   are kept, the rest falls back to the defaults, and the problems are reported for a log line.
 *
 * Owns: the document's shape and rules. Must not: keep anything but switches and quiet hours.
 */
import { validationFailed, type FieldError } from '@centcom/core';
import type { UserNotificationPrefs } from '../dispatcher/ports.js';
import { canonicalTimeZone, HH_MM, minutesOf } from './quiet-hours.js';

/** The categories with switches (CT-API-NOTIFY; `trial_ending` has none and always uses its default). */
export const PREFERENCE_CATEGORIES = Object.freeze([
  'approval_needed',
  'queue_turn',
  'mention',
  'member_joined',
  'member_left',
  'agent_done',
  'ci_failed',
  'pr_merged',
  'usage_warning',
  'quota_reached',
  'billing_issue',
  'invite_received',
  'update_available',
  'security_alert',
] as const);

/** A category with switches. */
export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number];

/** The channels (`os` is client-local). */
export const PREFERENCE_CHANNELS = Object.freeze(['inbox', 'push', 'email', 'os'] as const);

/** A channel. */
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

/** Categories whose inbox no switch can turn off (and quiet hours never touch). */
export const INBOX_ALWAYS_ON: ReadonlySet<PreferenceCategory> = new Set([
  'security_alert',
  'billing_issue',
]);

/** Largest document accepted, in bytes (the PUT body limit too). */
export const PREFERENCES_MAX_BYTES = 8192;

/** The switches of one category. */
export type ChannelSwitches = Record<PreferenceChannel, boolean>;

/** A complete document: every category with every switch. */
export interface CompletePreferences {
  channels: Record<PreferenceCategory, ChannelSwitches>;
  quiet_hours: UserNotificationPrefs['quiet_hours'];
}

/** The contract's default channels of a category. */
export function defaultSwitches(category: PreferenceCategory): ChannelSwitches {
  return {
    inbox: true,
    push: category === 'approval_needed',
    email: category === 'billing_issue',
    os: category === 'approval_needed',
  };
}

/** The defaults of a user who never saved preferences: a fresh copy. */
export function defaultPreferences(): CompletePreferences {
  const channels = {} as Record<PreferenceCategory, ChannelSwitches>;
  for (const category of PREFERENCE_CATEGORIES) channels[category] = defaultSwitches(category);
  return { channels, quiet_hours: { enabled: false, allow_approval_needed: false } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCategory = (key: string): key is PreferenceCategory =>
  (PREFERENCE_CATEGORIES as readonly string[]).includes(key);

const isChannel = (key: string): key is PreferenceChannel =>
  (PREFERENCE_CHANNELS as readonly string[]).includes(key);

/** Reads `channels`, pushing issues; returns the complete switches. */
function readChannels(raw: unknown, issues: FieldError[]): CompletePreferences['channels'] {
  const out = defaultPreferences().channels;
  if (!isRecord(raw)) {
    issues.push({ pointer: '/channels', code: 'invalid_type', detail: 'must be an object' });
    return out;
  }
  for (const [category, switches] of Object.entries(raw)) {
    const at = `/channels/${category}`;
    if (!isCategory(category)) {
      issues.push({ pointer: at, code: 'invalid_value', detail: 'is not a notification category' });
      continue;
    }
    if (!isRecord(switches)) {
      issues.push({ pointer: at, code: 'invalid_type', detail: 'must be an object of switches' });
      continue;
    }
    for (const [channel, on] of Object.entries(switches)) {
      if (!isChannel(channel)) {
        issues.push({
          pointer: `${at}/${channel}`,
          code: 'invalid_value',
          detail: 'must be one of inbox, push, email, os',
        });
      } else if (typeof on !== 'boolean') {
        issues.push({
          pointer: `${at}/${channel}`,
          code: 'invalid_type',
          detail: 'must be a boolean',
        });
      } else {
        out[category][channel] = on;
      }
    }
  }
  for (const category of INBOX_ALWAYS_ON) out[category].inbox = true;
  return out;
}

/** Reads `quiet_hours`, pushing issues; returns the window (off when unusable). */
function readQuietHours(raw: unknown, issues: FieldError[]): CompletePreferences['quiet_hours'] {
  const off = { enabled: false, allow_approval_needed: false };
  if (!isRecord(raw)) {
    issues.push({ pointer: '/quiet_hours', code: 'invalid_type', detail: 'must be an object' });
    return off;
  }
  const before = issues.length;
  const enabled = raw['enabled'];
  if (typeof enabled !== 'boolean') {
    issues.push({
      pointer: '/quiet_hours/enabled',
      code: 'invalid_type',
      detail: 'must be a boolean',
    });
  }
  const allow = raw['allow_approval_needed'];
  if (allow !== undefined && typeof allow !== 'boolean') {
    issues.push({
      pointer: '/quiet_hours/allow_approval_needed',
      code: 'invalid_type',
      detail: 'must be a boolean',
    });
  }
  const times: Partial<Record<'start' | 'end', string>> = {};
  for (const key of ['start', 'end'] as const) {
    const value = raw[key];
    if (value === undefined) {
      if (enabled === true) {
        issues.push({
          pointer: `/quiet_hours/${key}`,
          code: 'required',
          detail: 'is required when quiet hours are on',
        });
      }
    } else if (typeof value !== 'string' || !HH_MM.test(value)) {
      issues.push({
        pointer: `/quiet_hours/${key}`,
        code: 'invalid_format',
        detail: 'must be HH:MM, 00:00 to 23:59',
      });
    } else {
      times[key] = value;
    }
  }
  if (times.start !== undefined && minutesOf(times.start) === minutesOf(times.end)) {
    issues.push({
      pointer: '/quiet_hours/end',
      code: 'invalid_value',
      detail: 'must differ from start',
    });
  }
  let timezone: string | undefined;
  const zone = raw['timezone'];
  if (zone === undefined) {
    if (enabled === true) {
      issues.push({
        pointer: '/quiet_hours/timezone',
        code: 'required',
        detail: 'is required when quiet hours are on',
      });
    }
  } else {
    const canonical = canonicalTimeZone(zone);
    if (canonical === null) {
      issues.push({
        pointer: '/quiet_hours/timezone',
        code: 'invalid_value',
        detail: 'must be an IANA time zone name, such as Europe/Berlin',
      });
    } else {
      timezone = canonical;
    }
  }
  if (issues.length > before) return off;
  return {
    enabled: enabled === true,
    ...(times.start === undefined ? {} : { start: times.start }),
    ...(times.end === undefined ? {} : { end: times.end }),
    ...(timezone === undefined ? {} : { timezone }),
    allow_approval_needed: allow === true,
  };
}

/** Reads a document, collecting every issue; the result is complete. */
function read(body: unknown, issues: FieldError[]): CompletePreferences {
  if (!isRecord(body)) {
    issues.push({ pointer: '', code: 'invalid_type', detail: 'must be an object' });
    return defaultPreferences();
  }
  return {
    channels:
      body['channels'] === undefined
        ? (issues.push({ pointer: '/channels', code: 'required', detail: 'is required' }),
          defaultPreferences().channels)
        : readChannels(body['channels'], issues),
    quiet_hours:
      body['quiet_hours'] === undefined
        ? (issues.push({ pointer: '/quiet_hours', code: 'required', detail: 'is required' }),
          defaultPreferences().quiet_hours)
        : readQuietHours(body['quiet_hours'], issues),
  };
}

/** A PUT body as a complete document; a 422 listing every problem otherwise. */
export function parsePreferences(body: unknown): CompletePreferences {
  const issues: FieldError[] = [];
  const prefs = read(body, issues);
  if (issues.length > 0) {
    throw validationFailed(issues, 'Some notification preferences are not valid.');
  }
  return prefs;
}

/**
 * A stored document as a complete one, leniently: what validates is kept, the rest is the default.
 * `issues` names what was dropped (pointers and codes only).
 */
export function readStoredPreferences(doc: unknown): {
  prefs: CompletePreferences;
  issues: FieldError[];
} {
  const issues: FieldError[] = [];
  return { prefs: read(doc, issues), issues };
}

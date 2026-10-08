/**
 * Where a notification goes (B063, CT-NOTIF-PAYLOAD "Channels per category", "Quiet hours"):
 *
 * - Defaults: approval_needed → inbox, push, os; billing_issue → inbox, email; every other
 *   category → inbox. A user's channel switches (CT-API-NOTIFY) override them per channel.
 * - security_alert and billing_issue always reach the inbox, whatever the switches, and quiet
 *   hours never touch them.
 * - Quiet hours drop push and os, except a high-priority approval_needed when the user allowed it
 *   (`quiet_hours.allow_approval_needed`).
 *
 * Owns: the routing rules and the default quiet-hours clock.
 */
import {
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPriority,
} from '@centcom/core';
import type { QuietHoursPort, UserNotificationPrefs } from './ports.js';

/** Categories no switch or quiet hours can keep out of the inbox. */
export const MANDATORY_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'security_alert',
  'billing_issue',
]);

/** The contract's default channels of a category. */
export function defaultChannels(category: NotificationCategory): NotificationChannel[] {
  if (category === 'approval_needed') return ['inbox', 'push', 'os'];
  if (category === 'billing_issue') return ['inbox', 'email'];
  return ['inbox'];
}

/** What decides a notification's channels. */
export interface RoutingInput {
  category: NotificationCategory;
  priority: NotificationPriority;
  /** Null: the user never set preferences (defaults apply). */
  prefs: UserNotificationPrefs | null;
  /** Quiet hours are on for the user now. */
  quiet: boolean;
}

/** The channels a notification goes to. */
export function decideChannels(input: RoutingInput): Set<NotificationChannel> {
  const chosen = new Set(defaultChannels(input.category));
  const switches = (
    input.prefs?.channels as Record<string, Record<string, unknown> | undefined> | undefined
  )?.[input.category];
  for (const channel of NOTIFICATION_CHANNELS) {
    const on = switches?.[channel];
    if (on === true) chosen.add(channel);
    else if (on === false) chosen.delete(channel);
  }
  if (MANDATORY_CATEGORIES.has(input.category)) {
    chosen.add('inbox');
    return chosen;
  }
  if (input.quiet) {
    const bypass =
      input.category === 'approval_needed' &&
      input.priority === 'high' &&
      input.prefs?.quiet_hours.allow_approval_needed === true;
    if (!bypass) {
      chosen.delete('push');
      chosen.delete('os');
    }
  }
  return chosen;
}

const minutes = (hhmm: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
};

/** The minute of the day at `now` in `timeZone` (UTC when the zone is unknown). */
function minuteOfDay(now: Date, timeZone: string | undefined): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/**
 * Quiet hours by the user's own settings: on when enabled and the local time (in
 * `quiet_hours.timezone`) is in [start, end), a window that may cross midnight. An empty or
 * malformed window is never quiet.
 */
export const quietHours: QuietHoursPort = {
  isQuiet(prefs, now) {
    const q = prefs.quiet_hours;
    if (!q.enabled || q.start === undefined || q.end === undefined) return false;
    const start = minutes(q.start);
    const end = minutes(q.end);
    if (start === null || end === null || start === end) return false;
    const t = minuteOfDay(now, q.timezone);
    return start < end ? t >= start && t < end : t >= start || t < end;
  },
};

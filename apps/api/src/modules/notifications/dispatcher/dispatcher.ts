/**
 * The notification dispatcher (B063, CT-NOTIF-PAYLOAD).
 *
 * - **publish(event):** checks the event (params.ts) and queues it on `notify.dispatch` under a
 *   new event id. A bad event throws a NotificationEventError and nothing is queued; a queue that
 *   cannot be reached throws a 503 `service_unavailable` (retryable): the producing lane decides
 *   what to do with the event (its outbox), it is never dropped silently.
 * - **process(job)** (the worker's `notify.dispatch` job): resolves the recipients, and for each
 *   one reads the preferences (the defaults when they cannot be read), decides the channels, and
 *   writes the notification (once per user and event; once per dedupe key in 10 minutes). Then,
 *   for a row it wrote: a push when the channels hold push, and an e-mail at once when they hold
 *   email and the item is urgent (high priority, security_alert, billing_issue); other e-mail
 *   items wait for the hourly digest. A failing channel never stops the others or the inbox row:
 *   it is logged and counted.
 *
 * Logs carry the category, counts and ids, never param values.
 *
 * Owns: publishing and dispatching. Must not: put display text in a payload, or notify anyone
 * outside the related workspace or session.
 */
import { randomBytes } from 'node:crypto';
import { newId as makeId } from '@centcom/contracts';
import {
  noopMetrics,
  notifyDispatchJobOptions,
  unavailable,
  type Logger,
  type Metrics,
  type NotificationEvent,
  type NotifyDispatchJobData,
} from '@centcom/core';
import { checkEvent } from './params.js';
import type {
  DispatchQueue,
  EmailPort,
  NotificationPayload,
  NotificationStorePort,
  PreferencesPort,
  PushSenderPort,
  QuietHoursPort,
  UserNotificationPrefs,
} from './ports.js';
import { resolveRecipients } from './recipients.js';
import { decideChannels, MANDATORY_CATEGORIES, quietHours } from './routing.js';

/** Events of one dedupe key for one user within this long make one notification. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** The details of the dispatcher's own problems (GUIDELINES §3.4). */
export const DISPATCHER_DETAILS = Object.freeze({
  unavailable: 'Notifications cannot be queued right now; try again.',
} as const);

/** The CT-NOTIF-PAYLOAD of a notification. */
export function buildPayload(
  event: NotificationEvent,
  id: string,
  createdAt: Date,
): NotificationPayload {
  return {
    id,
    created_at: createdAt.toISOString(),
    read_at: null,
    category: event.category,
    title_key: `notif.${event.category}.title`,
    body_key: `notif.${event.category}.body`,
    params: { ...event.params },
    ...(event.action === undefined ? {} : { action: { ...event.action } }),
    priority: event.priority ?? 'normal',
  };
}

/** Options for NotificationDispatcher. */
export interface NotificationDispatcherOptions {
  store: NotificationStorePort;
  preferences: PreferencesPort;
  /** Default `quietHours` (the user's own window and time zone). */
  quietHours?: QuietHoursPort;
  push: PushSenderPort;
  email: EmailPort;
  queue: DispatchQueue;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Makes `ntf_` ids; default CT-IDS `newId`. */
  newId?: () => string;
  /** Writes `notification.*` lines (category, counts, ids). */
  logger?: Logger;
  /**
   * Receives `notifications_published_total{category}`, `notifications_written_total{category}`,
   * `notifications_deduped_total`, `notification_channel_failures_total{channel}` and
   * `notification_preferences_unavailable_total`.
   */
  metrics?: Metrics;
}

/** What one dispatch did. */
export interface DispatchResult {
  recipients: number;
  written: number;
  skipped: number;
}

/** Publishes and dispatches notifications. */
export class NotificationDispatcher {
  readonly #o: NotificationDispatcherOptions;
  readonly #clock: () => number;
  readonly #newId: () => string;
  readonly #quiet: QuietHoursPort;
  readonly #metrics: Metrics;

  constructor(options: NotificationDispatcherOptions) {
    this.#o = options;
    this.#clock = options.clock ?? Date.now;
    this.#newId = options.newId ?? (() => makeId('ntf'));
    this.#quiet = options.quietHours ?? quietHours;
    this.#metrics = options.metrics ?? noopMetrics;
  }

  /** Checks and queues `event`; resolves its event id. */
  async publish(event: NotificationEvent): Promise<string> {
    checkEvent(event);
    const eventId = randomBytes(16).toString('base64url');
    const data: NotifyDispatchJobData = {
      eventId,
      event,
      publishedAt: new Date(this.#clock()).toISOString(),
    };
    try {
      await this.#o.queue.add('dispatch', data, { ...notifyDispatchJobOptions(), jobId: eventId });
    } catch {
      throw unavailable(1, DISPATCHER_DETAILS.unavailable);
    }
    this.#metrics.counter('notifications_published_total', { category: event.category }).inc();
    this.#o.logger?.info({ event_id: eventId, category: event.category }, 'notification.published');
    return eventId;
  }

  /** Dispatches a queued event (the `notify.dispatch` job). Running it again writes nothing new. */
  async process(data: NotifyDispatchJobData): Promise<DispatchResult> {
    const { event, eventId } = data;
    checkEvent(event);
    const users = await resolveRecipients(event, this.#o.store);
    const now = new Date(this.#clock());
    const priority = event.priority ?? 'normal';
    let written = 0;
    for (const userId of users) {
      const prefs = await this.#prefs(userId);
      const quiet = prefs !== null && this.#quiet.isQuiet(prefs, now);
      const channels = decideChannels({ category: event.category, priority, prefs, quiet });
      const urgentEmail =
        channels.has('email') && (priority === 'high' || MANDATORY_CATEGORIES.has(event.category));
      const payload = buildPayload(event, this.#newId(), now);
      const outcome = await this.#o.store.insert(
        {
          id: payload.id,
          userId,
          eventId,
          category: event.category,
          params: payload.params,
          priority,
          action: payload.action ?? null,
          channels: [...channels].sort(),
          dedupeKey: event.dedupeKey ?? null,
          digestPending: channels.has('email') && !urgentEmail,
          createdAt: now,
        },
        DEDUPE_WINDOW_MS,
      );
      if (outcome !== 'inserted') {
        this.#metrics.counter('notifications_deduped_total').inc();
        continue;
      }
      written++;
      this.#metrics.counter('notifications_written_total', { category: event.category }).inc();
      if (channels.has('push')) {
        await this.#channel('push', () => this.#o.push.enqueue(userId, payload));
      }
      if (urgentEmail) {
        await this.#channel('email', () =>
          this.#o.email.enqueue(userId, 'notification', {
            items: [payload],
            idempotencyKey: payload.id,
          }),
        );
      }
    }
    this.#o.logger?.info(
      {
        event_id: eventId,
        category: event.category,
        recipients: users.length,
        written,
        skipped: users.length - written,
      },
      'notification.dispatched',
    );
    return { recipients: users.length, written, skipped: users.length - written };
  }

  /** The user's preferences; null (the defaults) when they cannot be read. */
  async #prefs(userId: string): Promise<UserNotificationPrefs | null> {
    try {
      return await this.#o.preferences.get(userId);
    } catch {
      this.#metrics.counter('notification_preferences_unavailable_total').inc();
      this.#o.logger?.warn({ user_id: userId }, 'notification.preferences_unavailable');
      return null;
    }
  }

  /** Runs one channel's send; a failure is logged and counted, never thrown. */
  async #channel(channel: 'push' | 'email', send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (err) {
      this.#metrics.counter('notification_channel_failures_total', { channel }).inc();
      this.#o.logger?.warn(
        { channel, error: err instanceof Error ? err.name : typeof err },
        'notification.channel_failed',
      );
    }
  }
}

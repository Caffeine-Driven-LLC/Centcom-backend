/**
 * Test helpers for the notification dispatcher (B063): an in-memory NotificationStore with the
 * Postgres store's rules (one row per user and event, a sliding dedupe window, digest items marked
 * only when the send succeeds), recorders for the push, e-mail and preferences ports, a queue that
 * keeps what is published, and a dispatcher over all of them on a movable clock.
 */
import { newId } from '@centcom/contracts';
import type { NotifyDispatchJobData, WorkspaceRole } from '@centcom/core';
import type {
  NewNotification,
  NotificationInsert,
  NotificationRecord,
  NotificationStore,
} from '@centcom/db';
import {
  NotificationDispatcher,
  type NotificationPayload,
  type UserNotificationPrefs,
} from '../../../src/modules/notifications/dispatcher/index.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';

/** When the tests start: 2026-10-07T12:00:00Z. */
export const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

/** Notifications and the membership tables they are resolved against, in memory. */
export class MemoryNotificationStore implements NotificationStore {
  rows: NotificationRecord[] = [];
  readonly users = new Map<string, 'active' | 'deleted'>();
  readonly liveWorkspaces = new Set<string>();
  memberships: { workspaceId: string; userId: string; role: WorkspaceRole }[] = [];
  sessionMembers: { id: string; sessionId: string; userId: string; leftAt: Date | null }[] = [];

  addUser(status: 'active' | 'deleted' = 'active'): string {
    const id = newId('usr');
    this.users.set(id, status);
    return id;
  }

  addWorkspace(): string {
    const id = newId('wsp');
    this.liveWorkspaces.add(id);
    return id;
  }

  join(workspaceId: string, userId: string, role: WorkspaceRole): void {
    this.memberships.push({ workspaceId, userId, role });
  }

  joinSession(sessionId: string, userId: string, leftAt: Date | null = null): string {
    const id = newId('mem');
    this.sessionMembers.push({ id, sessionId, userId, leftAt });
    return id;
  }

  #active = (userId: string): boolean => this.users.get(userId) === 'active';

  insert(row: NewNotification, dedupeWindowMs: number): Promise<NotificationInsert> {
    if (this.rows.some((r) => r.userId === row.userId && r.eventId === row.eventId)) {
      return Promise.resolve('duplicate_event');
    }
    if (
      row.dedupeKey !== null &&
      this.rows.some(
        (r) =>
          r.userId === row.userId &&
          r.dedupeKey === row.dedupeKey &&
          r.createdAt.getTime() > row.createdAt.getTime() - dedupeWindowMs,
      )
    ) {
      return Promise.resolve('deduped');
    }
    this.rows.push({ ...row, readAt: null, digestSentAt: null });
    return Promise.resolve('inserted');
  }

  forUser(userId: string): Promise<NotificationRecord[]> {
    return Promise.resolve(this.rows.filter((r) => r.userId === userId));
  }

  usersWithPendingDigest(): Promise<string[]> {
    return Promise.resolve(
      [...new Set(this.rows.filter((r) => r.digestPending).map((r) => r.userId))].sort(),
    );
  }

  async takeDigest(
    userId: string,
    max: number,
    now: Date,
    send: (items: NotificationRecord[]) => Promise<void>,
  ): Promise<number> {
    const items = this.rows
      .filter((r) => r.userId === userId && r.digestPending)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, max);
    if (items.length === 0) return 0;
    await send(items.map((r) => ({ ...r })));
    for (const item of items) {
      item.digestPending = false;
      item.digestSentAt = now;
    }
    return items.length;
  }

  workspaceMembers(workspaceId: string, roles: readonly WorkspaceRole[]): Promise<string[]> {
    if (!this.liveWorkspaces.has(workspaceId)) return Promise.resolve([]);
    return Promise.resolve(
      this.memberships
        .filter(
          (m) => m.workspaceId === workspaceId && roles.includes(m.role) && this.#active(m.userId),
        )
        .map((m) => m.userId),
    );
  }

  sessionMemberUsers(sessionId: string, memberIds: readonly string[]): Promise<string[]> {
    return Promise.resolve(
      this.sessionMembers
        .filter(
          (m) =>
            m.sessionId === sessionId &&
            memberIds.includes(m.id) &&
            m.leftAt === null &&
            this.#active(m.userId),
        )
        .map((m) => m.userId),
    );
  }

  workspaceMembersAmong(workspaceId: string, userIds: readonly string[]): Promise<string[]> {
    if (!this.liveWorkspaces.has(workspaceId)) return Promise.resolve([]);
    return Promise.resolve(
      this.memberships
        .filter(
          (m) =>
            m.workspaceId === workspaceId && userIds.includes(m.userId) && this.#active(m.userId),
        )
        .map((m) => m.userId),
    );
  }

  sessionUsersAmong(sessionId: string, userIds: readonly string[]): Promise<string[]> {
    return Promise.resolve(
      this.sessionMembers
        .filter(
          (m) =>
            m.sessionId === sessionId &&
            userIds.includes(m.userId) &&
            m.leftAt === null &&
            this.#active(m.userId),
        )
        .map((m) => m.userId),
    );
  }

  activeUsers(userIds: readonly string[]): Promise<string[]> {
    return Promise.resolve(userIds.filter(this.#active));
  }
}

/** Preferences with no channel switches and quiet hours off, plus `overrides`. */
export function prefs(overrides: Partial<UserNotificationPrefs> = {}): UserNotificationPrefs {
  return { channels: {}, quiet_hours: { enabled: false }, ...overrides };
}

/** Quiet hours on for the whole day, so they are on whenever a test runs. */
export const ALWAYS_QUIET = (allowApproval = false): UserNotificationPrefs['quiet_hours'] => ({
  enabled: true,
  start: '00:00',
  end: '23:59',
  timezone: 'UTC',
  allow_approval_needed: allowApproval,
});

/** The dispatcher and its recorders. */
export interface TestDispatcher {
  dispatcher: NotificationDispatcher;
  store: MemoryNotificationStore;
  /** Jobs published, in order. */
  queued: NotifyDispatchJobData[];
  pushes: { userId: string; payload: NotificationPayload }[];
  emails: {
    userId: string;
    template: string;
    items: NotificationPayload[];
    idempotencyKey: string;
  }[];
  preferences: Map<string, UserNotificationPrefs>;
  clock: { now: number };
  failures: { push: boolean; email: boolean; queue: boolean; preferences: boolean };
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
  /** Dispatches every queued job (as the worker would), oldest first, and empties the queue. */
  drain(): Promise<void>;
}

export function testDispatcher(store = new MemoryNotificationStore()): TestDispatcher {
  const clock = { now: T0 };
  const failures = { push: false, email: false, queue: false, preferences: false };
  const queued: NotifyDispatchJobData[] = [];
  const pushes: TestDispatcher['pushes'] = [];
  const emails: TestDispatcher['emails'] = [];
  const preferences = new Map<string, UserNotificationPrefs>();
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const dispatcher = new NotificationDispatcher({
    store,
    preferences: {
      get: (userId) =>
        failures.preferences
          ? Promise.reject(new Error('preferences down'))
          : Promise.resolve(preferences.get(userId) ?? null),
    },
    push: {
      enqueue: (userId, payload) => {
        if (failures.push) return Promise.reject(new Error('push down'));
        pushes.push({ userId, payload });
        return Promise.resolve();
      },
    },
    email: {
      enqueue: (userId, template, payload) => {
        if (failures.email) return Promise.reject(new Error('email down'));
        emails.push({ userId, template, ...payload });
        return Promise.resolve();
      },
    },
    queue: {
      add: (_name, data) => {
        if (failures.queue) return Promise.reject(new Error('redis down'));
        queued.push(data);
        return Promise.resolve();
      },
    },
    clock: () => clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  return {
    dispatcher,
    store,
    queued,
    pushes,
    emails,
    preferences,
    clock,
    failures,
    captured,
    recorded,
    drain: async () => {
      while (queued.length > 0) {
        const job = queued.shift();
        if (job !== undefined) await dispatcher.process(job);
      }
    },
  };
}

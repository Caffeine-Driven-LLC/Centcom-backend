/**
 * Fixtures for the quota signal tests (B076):
 *
 * - `memoryQuotaSignalStore`: the store in one process, with Postgres's semantics where they
 *   matter: decisions of one workspace run one at a time (the advisory lock) and commit or roll
 *   back as a whole; a delivery runs only if no decision or delivery of the workspace holds the
 *   lock, and each of its marks commits at once, only on a step not yet marked (`failMark` makes
 *   one throw instead). Each claim gets a distinct `claimedAt`.
 * - `scripted*`: B075's counters, B069's entitlements (with `rev`), the notice channel, B063's
 *   dispatcher (checking events with its own rules, `checkEvent`) and B081's emitter (the real
 *   `createWebhookEventEmitter`, so CT-WEBHOOKS' data rules apply), each recording what it got and
 *   able to fail.
 * - `signalsWith`: a `QuotaSignals` over all of them, a Pro-like workspace (hosted, 6 000 hosted
 *   minutes, 1 000 queue items) in the October 2026 period.
 */
import {
  createWebhookEventEmitter,
  type NotificationEvent,
  type WebhookEvent,
} from '@centcom/core';
import { newId } from '@centcom/contracts';
import type { QuotaNotice } from '../../../src/modules/billing/quota/delivery.js';
import type { MeteredKey, SignalLevel } from '../../../src/modules/billing/quota/levels.js';
import { QuotaSignals } from '../../../src/modules/billing/quota/service.js';
import { memoryQuotaStateCache } from '../../../src/modules/billing/quota/state-cache.js';
import type {
  DeliveryStep,
  QuotaSignalStore,
  SignalDeliveryTx,
  SignalRow,
} from '../../../src/modules/billing/quota/store.js';
import { checkEvent } from '../../../src/modules/notifications/dispatcher/params.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';

export { newId };

/** The October 2026 period of the tests' workspaces. */
export const PERIOD = Object.freeze({
  start: '2026-10-01T00:00:00.000Z',
  end: '2026-11-01T00:00:00.000Z',
});
/** An instant inside it. */
export const NOW = new Date('2026-10-15T12:00:00.000Z');

const keyOf = (r: { workspaceId: string; limitKey: string; periodStart: Date; level: string }) =>
  `${r.workspaceId}|${r.limitKey}|${r.periodStart.toISOString()}|${r.level}`;

const STEP_FIELD = { notice: 'firedAt', notification: 'notifiedAt', webhook: 'webhookAt' } as const;

/** One workspace's advisory lock: `acquire` waits, `tryAcquire` does not. */
class Lock {
  #held = false;
  readonly #waiters: (() => void)[] = [];
  acquire(): Promise<void> {
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  tryAcquire(): boolean {
    if (this.#held) return false;
    this.#held = true;
    return true;
  }
  release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) this.#held = false;
    else next();
  }
}

/** The store in one process (see the module comment). */
export function memoryQuotaSignalStore() {
  const rows = new Map<string, SignalRow>();
  const limits = new Map<string, number>();
  const locks = new Map<string, Lock>();
  const lockOf = (workspaceId: string): Lock => {
    let lock = locks.get(workspaceId);
    if (lock === undefined) {
      lock = new Lock();
      locks.set(workspaceId, lock);
    }
    return lock;
  };
  let failNextDecide: Error | null = null;
  let failMark: { step: DeliveryStep; err: Error } | null = null;
  let claims = 0;

  const store: QuotaSignalStore = {
    async decide(workspaceId, fn) {
      const lock = lockOf(workspaceId);
      await lock.acquire();
      const draft = new Map(rows);
      const draftLimits = new Map(limits);
      try {
        if (failNextDecide !== null) {
          const err = failNextDecide;
          failNextDecide = null;
          throw err;
        }
        const value = await fn({
          claimed(periodStart) {
            return Promise.resolve(
              [...draft.values()]
                .filter(
                  (r) =>
                    r.workspaceId === workspaceId &&
                    r.periodStart.getTime() === periodStart.getTime(),
                )
                .map((r) => ({
                  limitKey: r.limitKey,
                  level: r.level,
                  limitValue: draftLimits.get(keyOf(r)) ?? 0,
                })),
            );
          },
          claim({ limitValue, ...row }) {
            claims += 1;
            const full: SignalRow = {
              ...row,
              workspaceId,
              claimedAt: new Date(NOW.getTime() + claims),
              firedAt: null,
              notifiedAt: null,
              webhookAt: null,
            };
            if (draft.has(keyOf(full))) return Promise.resolve(false);
            draft.set(keyOf(full), full);
            draftLimits.set(keyOf(full), limitValue);
            return Promise.resolve(true);
          },
          rearm(limitKey, periodStart, levels) {
            let n = 0;
            for (const level of levels) {
              const key = keyOf({ workspaceId, limitKey, periodStart, level });
              draftLimits.delete(key);
              if (draft.delete(key)) n += 1;
            }
            return Promise.resolve(n);
          },
        });
        rows.clear();
        for (const [k, v] of draft) rows.set(k, v);
        limits.clear();
        for (const [k, v] of draftLimits) limits.set(k, v);
        return value;
      } finally {
        lock.release();
      }
    },

    async deliver(workspaceId, fn) {
      const lock = lockOf(workspaceId);
      if (!lock.tryAcquire()) return { ran: false };
      try {
        const tx: SignalDeliveryTx = {
          pending() {
            const order = (l: SignalLevel) => (l === 'warn' ? 0 : 1);
            return Promise.resolve(
              [...rows.values()]
                .filter(
                  (r) =>
                    r.workspaceId === workspaceId &&
                    (r.firedAt === null || r.notifiedAt === null || r.webhookAt === null),
                )
                .sort(
                  (a, b) =>
                    a.periodStart.getTime() - b.periodStart.getTime() ||
                    order(a.level) - order(b.level) ||
                    a.limitKey.localeCompare(b.limitKey),
                )
                .map((r) => ({ ...r })),
            );
          },
          mark(key, step, at) {
            if (failMark?.step === step) {
              const { err } = failMark;
              failMark = null;
              return Promise.reject(err);
            }
            const row = rows.get(keyOf(key));
            if (row !== undefined && row[STEP_FIELD[step]] === null) row[STEP_FIELD[step]] = at;
            return Promise.resolve();
          },
        };
        return { ran: true, value: await fn(tx) };
      } finally {
        lock.release();
      }
    },

    levels(workspaceId, periodStart) {
      const levels: Partial<Record<MeteredKey, SignalLevel>> = {};
      for (const r of rows.values()) {
        if (r.workspaceId !== workspaceId || r.periodStart.getTime() !== periodStart.getTime()) {
          continue;
        }
        levels[r.limitKey] = levels[r.limitKey] === 'reached' ? 'reached' : r.level;
      }
      return Promise.resolve(levels);
    },

    sweepCandidates(after, limit) {
      const ids = [...new Set([...rows.values()].map((r) => r.workspaceId))].sort();
      return Promise.resolve(ids.filter((id) => after === null || id > after).slice(0, limit));
    },
  };
  return {
    store,
    rows,
    /** The workspace's rows, as `limit/level` strings. */
    of: (workspaceId: string) =>
      [...rows.values()]
        .filter((r) => r.workspaceId === workspaceId)
        .map((r) => `${r.limitKey}/${r.level}`)
        .sort(),
    /** The limit each of the workspace's rows was claimed under, as `limit/level=value`. */
    limitsOf: (workspaceId: string) =>
      [...rows.values()]
        .filter((r) => r.workspaceId === workspaceId)
        .map((r) => `${r.limitKey}/${r.level}=${String(limits.get(keyOf(r)))}`)
        .sort(),
    failNextDecide(err: Error) {
      failNextDecide = err;
    },
    /** The next mark of `step` throws `err` (and marks nothing). */
    failMark(step: DeliveryStep, err: Error) {
      failMark = { step, err };
    },
  };
}

/** B075's counters: the relay meters of each workspace in the October period. */
export function scriptedCounters() {
  const totals = new Map<
    string,
    Partial<Record<'relay.hosted_minutes' | 'relay.queue_items', number>>
  >();
  return {
    totals,
    set(workspaceId: string, hosted?: number, queue?: number) {
      totals.set(workspaceId, {
        ...(hosted === undefined ? {} : { 'relay.hosted_minutes': hosted }),
        ...(queue === undefined ? {} : { 'relay.queue_items': queue }),
      });
    },
    port: {
      totals: (workspaceId: string) => Promise.resolve({ ...(totals.get(workspaceId) ?? {}) }),
    },
  };
}

/** The limits of a test workspace. */
export interface TestLimits {
  relay_access?: boolean;
  hosted_minutes_month?: number | null;
  queue_items_month?: number | null;
}

/** B069's entitlements: a Pro-like plan per workspace, with `rev`. */
export function scriptedEntitlements() {
  const entries = new Map<
    string,
    { rev: number; limits: TestLimits; period?: { start: string; end: string } }
  >();
  let reads = 0;
  /** Called on each read; may change the entry (a limit changed mid-evaluation). */
  let onRead: ((workspaceId: string, read: number) => void) | null = null;
  return {
    entries,
    reads: () => reads,
    onRead(fn: ((workspaceId: string, read: number) => void) | null) {
      onRead = fn;
    },
    set(
      workspaceId: string,
      limits: TestLimits = {},
      period: { start: string; end: string } | null = PERIOD,
    ) {
      const previous = entries.get(workspaceId);
      entries.set(workspaceId, {
        rev: (previous?.rev ?? 0) + 1,
        limits: {
          relay_access: true,
          hosted_minutes_month: 6000,
          queue_items_month: 1000,
          ...limits,
        },
        ...(period === null ? {} : { period }),
      });
    },
    port: {
      get(workspaceId: string) {
        reads += 1;
        onRead?.(workspaceId, reads);
        const entry = entries.get(workspaceId);
        if (entry === undefined) return Promise.resolve(null);
        return Promise.resolve({
          rev: entry.rev,
          limits: { ...entry.limits } as Record<string, unknown>,
          ...(entry.period === undefined ? {} : { period: { ...entry.period } }),
        });
      },
    },
  };
}

/** Records published notices; `failures` makes the next publishes throw. */
export function recordingNotices() {
  const published: { channel: string; notice: QuotaNotice }[] = [];
  const failures: Error[] = [];
  return {
    published,
    failures,
    port: {
      publish(workspaceId: string, notice: QuotaNotice) {
        const failure = failures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        published.push({ channel: `relay:notice:${workspaceId}`, notice: structuredClone(notice) });
        return Promise.resolve();
      },
    },
  };
}

/** B063's dispatcher: checks each event with its rules and records it. */
export function recordingNotify() {
  const events: NotificationEvent[] = [];
  const failures: Error[] = [];
  return {
    events,
    failures,
    port: {
      publish(event: NotificationEvent) {
        const failure = failures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        checkEvent(event);
        events.push(structuredClone(event));
        return Promise.resolve(newId('ntf'));
      },
    },
  };
}

/** B081's emitter over a recording queue. */
export function recordingWebhooks() {
  const events: WebhookEvent[] = [];
  const failures: Error[] = [];
  const emit = createWebhookEventEmitter({
    queue: {
      add(_name, data) {
        const failure = failures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        events.push(structuredClone(data));
        return Promise.resolve();
      },
    },
  });
  return { events, failures, emit };
}

/** A QuotaSignals over the fixtures, with one hosted workspace. */
export function signalsWith(options: { clock?: () => number; sendTimeoutMs?: number } = {}) {
  const store = memoryQuotaSignalStore();
  const counters = scriptedCounters();
  const entitlements = scriptedEntitlements();
  const state = memoryQuotaStateCache(options.clock ?? (() => NOW.getTime()));
  const notices = recordingNotices();
  const notify = recordingNotify();
  const webhooks = recordingWebhooks();
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const signals = new QuotaSignals({
    store: store.store,
    counters: counters.port,
    entitlements: entitlements.port,
    cache: state.cache,
    notices: notices.port,
    notify: notify.port,
    emitWebhook: webhooks.emit,
    ...(options.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: options.sendTimeoutMs }),
    clock: options.clock ?? (() => NOW.getTime()),
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const ws = newId('wsp');
  entitlements.set(ws);
  return {
    signals,
    store,
    counters,
    entitlements,
    state,
    notices,
    notify,
    webhooks,
    captured,
    recorded,
    ws,
  };
}

/** One of each delivery: the notices' codes, the notifications' categories, the webhooks' pcts. */
export function sent(ctx: ReturnType<typeof signalsWith>) {
  return {
    notices: ctx.notices.published.map((p) => p.notice.code),
    notifications: ctx.notify.events.map((e) => `${e.category}:${String(e.params['limit'])}`),
    webhooks: ctx.webhooks.events.map((e) => `${String(e.data['limit'])}:${String(e.data['pct'])}`),
  };
}

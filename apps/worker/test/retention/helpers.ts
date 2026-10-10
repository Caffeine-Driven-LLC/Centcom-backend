/**
 * Fixtures for the retention tests (B090), in memory:
 *
 * - `memoryState`: the job's bookkeeping per workspace and dataset (enforced days, pending
 *   shortenings).
 * - `historyWorld`: workspaces, their sessions (state, end time, frames, blobs, snapshots), the
 *   history bookkeeping (`baseline`, `pending`, a view of `state` for `history`), retention
 *   overrides and owners; it is the history policy's store, B055's history purger (blobs first: a
 *   failed purge leaves the session's frames), a snapshot purger and the workspace purger's
 *   session reader. Purges can be made to fail (`failPurge`) or throttle (`throttle`, a
 *   BlobStoreError "DELETE answered 503"); `rounds` records how many purges each round had in
 *   flight.
 * - `scriptedEntitlements`: B069's `get`, per workspace: limits, null, or an error.
 * - `recordingNotices`, `recordingMailer`: what was published and mailed; either can fail.
 * - `memoryRuns`: the run reports; `memoryCursor`: the real cursor over an in-memory Redis;
 *   `ctxOf`: a policy context at NOW; `captureLogger` and `countingMetrics`.
 */
import { Writable } from 'node:stream';
import { newId } from '@centcom/contracts';
import { createLogger, createMemoryRedis, type MetricLabels, type Metrics } from '@centcom/core';
import {
  createDecideCursor,
  retentionCursorKey,
  type DueSession,
  type HistoryRetentionStore,
  type PendingShortening,
  type RetentionContext,
  type RetentionDataset,
  type RetentionRunStore,
  type RetentionStateStore,
  type SessionBlobPurger,
} from '../../src/index.js';

export { newId };

/** The run's instant in the tests. */
export const NOW = new Date('2026-10-15T03:00:00.000Z');
export const DAY = 24 * 60 * 60 * 1000;
export const daysAgo = (days: number, from: Date = NOW): Date =>
  new Date(from.getTime() - days * DAY);

/**
 * A policy context at NOW, or `over.now` (not a dry run, the default brake, a whole budget); its
 * clock stands still at that instant unless `over.clock` moves it.
 */
export function ctxOf(over: Partial<RetentionContext> = {}): RetentionContext {
  const now = over.now ?? NOW;
  return {
    now,
    dryRun: false,
    budgetMs: 30 * 60 * 1000,
    maxDeleteFraction: 0.2,
    force: false,
    clock: () => now.getTime(),
    ...over,
  };
}

/** The real cursor over an in-memory Redis; `of(policy)` reads it back. */
export function memoryCursor() {
  const redis = createMemoryRedis();
  return {
    redis,
    cursor: createDecideCursor(redis.kv),
    of: (policy: string) => redis.kv.get(retentionCursorKey(policy)),
  };
}

/** A session in the world. */
export interface WorldSession {
  workspaceId: string | null;
  state: 'pending' | 'live' | 'paused' | 'ended' | 'expired';
  endedAt: Date | null;
  frames: number;
  blobs: number;
  snapshots: number;
}

/** B055's error for an HTTP status (the class is matched by name). */
export function blobStoreError(status: number): Error {
  const err = new Error(`DELETE answered ${status}`);
  err.name = 'BlobStoreError';
  return err;
}

/** The job's bookkeeping in memory, per dataset: `baseline` and `pending` by workspace. */
export function memoryState() {
  const datasets: Record<
    RetentionDataset,
    { baseline: Map<string, number>; pending: Map<string, PendingShortening> }
  > = {
    history: { baseline: new Map(), pending: new Map() },
    audit: { baseline: new Map(), pending: new Map() },
  };
  const store: RetentionStateStore = {
    get(ws, dataset) {
      const d = datasets[dataset];
      const p = d.pending.get(ws);
      return Promise.resolve({
        baseline: d.baseline.get(ws) ?? null,
        pending: p === undefined ? null : { ...p },
      });
    },
    setBaseline(ws, dataset, days) {
      datasets[dataset].baseline.set(ws, days);
      return Promise.resolve();
    },
    announce(ws, dataset, p) {
      datasets[dataset].pending.set(ws, { ...p, noticeSentAt: null, emailSentAt: null });
      return Promise.resolve();
    },
    updatePending(ws, dataset, newDays) {
      const p = datasets[dataset].pending.get(ws);
      if (p !== undefined) datasets[dataset].pending.set(ws, { ...p, newDays });
      return Promise.resolve();
    },
    settle(ws, dataset, days) {
      datasets[dataset].baseline.set(ws, days);
      datasets[dataset].pending.delete(ws);
      return Promise.resolve();
    },
    markSent(ws, dataset, what, at) {
      const d = datasets[dataset];
      const p = d.pending.get(ws);
      if (p === undefined) return Promise.resolve();
      if (what === 'notice' && p.noticeSentAt === null)
        d.pending.set(ws, { ...p, noticeSentAt: at });
      if (what === 'email' && p.emailSentAt === null) d.pending.set(ws, { ...p, emailSentAt: at });
      return Promise.resolve();
    },
  };
  return { store, datasets };
}

/** The in-memory world (see the module comment). */
export function historyWorld() {
  const sessions = new Map<string, WorldSession>();
  const state = memoryState();
  const baseline = state.datasets.history.baseline;
  const pending = state.datasets.history.pending;
  const overrides = new Map<string, number>();
  const owners = new Map<string, { workspaceName: string; emails: string[] }>();
  let failPurge: (sessionId: string) => Error | null = () => null;
  let throttles = 0;
  const purgeCalls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const rounds: number[] = [];
  let roundOpen = false;

  const holds = (s: WorldSession) => s.frames > 0 || s.blobs > 0;
  const ended = (s: WorldSession) =>
    (s.state === 'ended' || s.state === 'expired') && s.endedAt !== null;
  const due = (workspaceId: string, endedBy: Date) =>
    [...sessions]
      .filter(
        ([, s]) =>
          s.workspaceId === workspaceId &&
          ended(s) &&
          holds(s) &&
          (s.endedAt?.getTime() ?? Infinity) <= endedBy.getTime(),
      )
      .sort(([a], [b]) => a.localeCompare(b));

  const store: HistoryRetentionStore = {
    workspacesWithHistory(after, limit) {
      const ids = [
        ...new Set(
          [...sessions.values()]
            .filter((s) => s.workspaceId !== null && ended(s) && holds(s))
            .map((s) => s.workspaceId as string),
        ),
      ]
        .sort()
        .filter((id) => after === null || id > after);
      return Promise.resolve(ids.slice(0, limit));
    },
    retentionOverride: (ws) => Promise.resolve(overrides.get(ws) ?? null),
    dueFrames: (ws, endedBy) =>
      Promise.resolve(due(ws, endedBy).reduce((sum, [, s]) => sum + s.frames, 0)),
    dueSessions(ws, endedBy, after, limit) {
      const page: DueSession[] = due(ws, endedBy)
        .filter(([id]) => after === null || id > after)
        .slice(0, limit)
        .map(([sessionId, s]) => ({ sessionId, frames: s.frames }));
      return Promise.resolve(page);
    },
    totalFrames: () =>
      Promise.resolve([...sessions.values()].reduce((sum, s) => sum + s.frames, 0)),
    owners: (ws) => Promise.resolve(owners.get(ws) ?? null),
  };

  const history: SessionBlobPurger = {
    async purge(sessionId) {
      purgeCalls.push(sessionId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Purges started before any of them resumes belong to one round.
      if (!roundOpen) {
        rounds.push(0);
        roundOpen = true;
      }
      rounds[rounds.length - 1] = (rounds.at(-1) ?? 0) + 1;
      try {
        await new Promise((resolve) => setImmediate(resolve));
        roundOpen = false;
        if (throttles > 0) {
          throttles -= 1;
          throw blobStoreError(503);
        }
        const failure = failPurge(sessionId);
        if (failure !== null) throw failure;
        const s = sessions.get(sessionId);
        if (s === undefined) return { deleted: 0, blobs: 0 };
        const result = { deleted: s.frames, blobs: s.blobs };
        s.frames = 0;
        s.blobs = 0;
        return result;
      } finally {
        inFlight -= 1;
      }
    },
  };

  const snapshots: SessionBlobPurger = {
    purge(sessionId) {
      const s = sessions.get(sessionId);
      const deleted = s?.snapshots ?? 0;
      if (s !== undefined) s.snapshots = 0;
      return Promise.resolve({ deleted, blobs: deleted });
    },
  };

  return {
    sessions,
    state,
    baseline,
    pending,
    overrides,
    rounds,
    owners,
    store,
    history,
    snapshots,
    sessionsReader: {
      sessionIds: (ws: string) =>
        Promise.resolve(
          [...sessions]
            .filter(([, s]) => s.workspaceId === ws)
            .map(([id]) => id)
            .sort(),
        ),
    },
    purgeCalls,
    maxInFlight: () => maxInFlight,
    /** A new workspace with one owner. */
    workspace(name = 'Acme'): string {
      const ws = newId('wsp');
      owners.set(ws, {
        workspaceName: name,
        emails: [`owner-${ws.slice(-6).toLowerCase()}@example.test`],
      });
      return ws;
    },
    /** Adds a session; `endedDaysAgo` null leaves it without an end. */
    session(
      workspaceId: string | null,
      opts: { state?: WorldSession['state']; endedDaysAgo?: number | null; frames?: number } = {},
    ): string {
      const sid = newId('ses');
      const frames = opts.frames ?? 10;
      const endedDaysAgo = opts.endedDaysAgo === undefined ? 1 : opts.endedDaysAgo;
      sessions.set(sid, {
        workspaceId,
        state: opts.state ?? 'ended',
        endedAt: endedDaysAgo === null ? null : daysAgo(endedDaysAgo),
        frames,
        blobs: Math.ceil(frames / 500),
        snapshots: 1,
      });
      return sid;
    },
    failPurge(fn: (sessionId: string) => Error | null) {
      failPurge = fn;
    },
    throttle(times: number) {
      throttles = times;
    },
    /** Frames still stored, per session. */
    frames: (sid: string) => sessions.get(sid)?.frames ?? 0,
  };
}

/** B069's entitlements per workspace: limits, null (none), or an error to throw. */
export function scriptedEntitlements() {
  const entries = new Map<string, Record<string, unknown> | null | Error>();
  return {
    entries,
    set(ws: string, limits: Record<string, unknown> | null | Error) {
      entries.set(ws, limits);
    },
    port: {
      get(ws: string) {
        const entry = entries.get(ws);
        if (entry instanceof Error) return Promise.reject(entry);
        if (entry === undefined || entry === null) return Promise.resolve(null);
        return Promise.resolve({ limits: { ...entry } });
      },
    },
  };
}

/** Pro's limits (CT-ENTITLEMENTS): 7 days of history, no audit log. */
export const PRO = Object.freeze({ history_days: 7, audit_log_days: 0, relay_access: true });
/** Team's: 30 days of history, 90 of audit. */
export const TEAM = Object.freeze({ history_days: 30, audit_log_days: 90, relay_access: true });

/** Records published notices; `failures` makes the next publishes throw. */
export function recordingNotices() {
  const published: { channel: string; message: unknown }[] = [];
  const failures: Error[] = [];
  return {
    published,
    failures,
    port: {
      publish(channel: string, message: string) {
        const failure = failures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        published.push({ channel, message: JSON.parse(message) as unknown });
        return Promise.resolve();
      },
    },
  };
}

/** Records mails; `failures` makes the next sends throw. */
export function recordingMailer() {
  const sent: {
    id: string;
    to: string;
    params: { workspaceName: string; days: string; effectiveAt: Date };
    idempotencyKey: string;
  }[] = [];
  const failures: Error[] = [];
  return {
    sent,
    failures,
    port: {
      send(
        id: 'history_retention_changed',
        to: string,
        params: { workspaceName: string; days: string; effectiveAt: Date },
        opts: { idempotencyKey: string },
      ) {
        const failure = failures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        sent.push({ id, to, params, idempotencyKey: opts.idempotencyKey });
        return Promise.resolve({ queued: true });
      },
    },
  };
}

/** The run reports in memory. */
export function memoryRuns() {
  const rows: {
    id: string;
    policy: string;
    startedAt: Date;
    finishedAt: Date | null;
    dryRun: boolean;
    scanned: number;
    purged: number;
    skipped: number;
    abortedReason: string | null;
  }[] = [];
  const store: RetentionRunStore = {
    closeInterrupted(policy, at) {
      let n = 0;
      for (const r of rows) {
        if (r.policy === policy && r.finishedAt === null) {
          r.finishedAt = at;
          r.abortedReason = 'interrupted';
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
    start(policy, dryRun, at) {
      const id = String(rows.length + 1);
      rows.push({
        id,
        policy,
        startedAt: at,
        finishedAt: null,
        dryRun,
        scanned: 0,
        purged: 0,
        skipped: 0,
        abortedReason: null,
      });
      return Promise.resolve(id);
    },
    finish(id, result, at) {
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) Object.assign(row, { ...result, finishedAt: at });
      return Promise.resolve();
    },
  };
  return { rows, store };
}

/** A logger whose lines are kept. */
export function captureLogger() {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'trace',
    service: 'worker',
    version: 'test',
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
  });
  const lines = (): Record<string, unknown>[] =>
    chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines };
}

/** A Metrics that counts counters and keeps histogram observations, by name and labels. */
export function countingMetrics() {
  const counts = new Map<string, number>();
  const observed: { name: string; value: number; labels: MetricLabels | undefined }[] = [];
  const key = (name: string, labels?: MetricLabels): string =>
    `${name}${JSON.stringify(labels ?? {})}`;
  const metrics: Metrics = {
    counter: (name, labels) => ({
      inc: (n = 1) => counts.set(key(name, labels), (counts.get(key(name, labels)) ?? 0) + n),
    }),
    histogram: (name) => ({ observe: (value, labels) => observed.push({ name, value, labels }) }),
  };
  return {
    metrics,
    observed,
    count: (name: string, labels?: MetricLabels) => counts.get(key(name, labels)) ?? 0,
  };
}

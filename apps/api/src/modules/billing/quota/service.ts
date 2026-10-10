/**
 * Quota signals (B076, CT-ENTITLEMENTS §5): turns metered usage (B075) into one-time signals at 80 %
 * (`warn`) and 100 % (`reached`) per workspace, limit and period, and keeps the quota state flag.
 *
 * `evaluateQuota(workspaceId, now)`:
 *
 * 1. Reads the entitlements (B069): none is a skip (logged); a workspace without `relay_access`
 *    is not hosted and is never evaluated (LAN and local use never reach the backend and are never
 *    signalled). The period is the entitlements' (else the UTC calendar month, as B075's).
 * 2. In one transaction holding the workspace's decision lock (store.ts):
 *    - re-reads the entitlements' `rev` (a change since step 1 runs the evaluation once more);
 *    - reads the period's usage (B075's counters), after the lock, so it is never older than what
 *      the previous decision saw, and each limit's level (levels.ts, integer math). A limit with no
 *      counter yet counts as unused (never `reached` from absent data); if it has signalled this
 *      period already, it is skipped (logged);
 *    - re-arms a claimed level only for the card's reasons: its limit was removed, or raised above
 *      the limit it was claimed under, so usage is now below it (a new period simply has no rows).
 *      Counters only grow within a period, so a lower reading under the same limit is never a
 *      fall, and changes nothing;
 *    - claims each level between what is still claimed and the current level (at most once per
 *      workspace, limit, period and level; after a re-arm too, so the rows, the hash and
 *      `warnings[]` agree), and writes the `quota:state:{wsp}` hash, all before commit.
 * 3. Delivers after the commit: the relay's notices first, in order (`warn` before `reached`), then
 *    the owners' notifications, then the webhook events (delivery.ts). Each step's mark commits
 *    right after its send succeeded, so a failure (Redis down, the dispatcher down, a lost
 *    connection) retries that step alone and never undoes the others; a step that failed makes
 *    the evaluation throw after the others ran, for the job to retry. Every send is given
 *    QUOTA_SEND_TIMEOUT_MS. Signals of a period that has ended are marked without sending.
 *
 * `getQuotaState` reads the hash, else the stored signals of the current period (and writes the
 * hash only if it is still missing, so it never replaces a newer decision's); `getWarnings` is its
 * `warnings[]` for CT-ENTITLEMENTS.
 *
 * Owns: these rules. Must not: block or throttle anything (B080 and the relay read the flag), log
 * usage numbers, or send display text.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { CounterStore } from '../../usage/counters.js';
import { periodOf } from '../../usage/period.js';
import { QUOTA_KEYS, QUOTA_METERS, subscribedPeriod } from '../../usage/quota.js';
import {
  notificationOf,
  noticeOf,
  webhookOf,
  type EmitWebhook,
  type NoticePort,
  type QuotaNotifyPort,
} from './delivery.js';
import {
  compareLevels,
  levelOf,
  levelsToClaim,
  levelsToRearm,
  maxLevel,
  pctOf,
  type MeteredKey,
  type QuotaLevel,
  type QuotaTransition,
  type SignalLevel,
} from './levels.js';
import {
  QUOTA_STATE_GRACE_MS,
  type QuotaStateCache,
  type QuotaStateLevels,
} from './state-cache.js';
import type {
  ClaimedLevel,
  DeliveryStep,
  QuotaSignalStore,
  SignalDeliveryTx,
  SignalRow,
} from './store.js';

/**
 * The most a delivery step waits for its send, so a Redis or queue outage (BullMQ's reconnect
 * backoff can last minutes) fails the step, for the job to retry, rather than holding the
 * workspace's lock. A failed step stops that step's loop, so timeouts hold a delivery for about
 * three times this at most; a decision waiting behind it gives up at `statement_timeout` (10 s)
 * and its job retries.
 */
export const QUOTA_SEND_TIMEOUT_MS = 5_000;

/** What quota signals read from the entitlements (B069's `EntitlementService.get`). */
export interface QuotaEntitlementsReader {
  get(workspaceId: string): Promise<{
    rev: number;
    limits: Partial<Record<MeteredKey, number | null>> & Record<string, unknown>;
    period?: { start: string; end: string };
  } | null>;
}

/** A delivery step that failed; the evaluation's job retries it. */
export class QuotaDeliveryError extends Error {
  override name = 'QuotaDeliveryError';
  constructor(
    readonly step: DeliveryStep,
    options: { cause: unknown },
  ) {
    super(`quota signal ${step} failed`, options);
  }
}

/** The `quota:state` hash could not be written; the job retries to rebuild it. */
export class QuotaStateCacheError extends Error {
  override name = 'QuotaStateCacheError';
}

/** The entitlements' `rev` moved during an evaluation. */
class StaleEntitlementsError extends Error {
  override name = 'StaleEntitlementsError';
}

/** A send that did not answer within its time. */
export class QuotaSendTimeoutError extends Error {
  override name = 'QuotaSendTimeoutError';
}

/**
 * `work`, or a QuotaSendTimeoutError after `ms`. A send abandoned this way may still complete;
 * its step is then sent again by the retry (the notification's dedupe key absorbs that one).
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new QuotaSendTimeoutError(`no answer within ${ms} ms`)), ms);
  });
  // A late failure of an abandoned send is not an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The highest of `rows`' levels, `ok` when there is none. */
const highest = (rows: readonly { level: SignalLevel }[]): QuotaLevel =>
  rows.reduce<QuotaLevel>((top, r) => maxLevel(top, r.level), 'ok');

/** What the service needs. */
export interface QuotaSignalsDeps {
  store: QuotaSignalStore;
  counters: Pick<CounterStore, 'totals'>;
  entitlements: QuotaEntitlementsReader;
  cache: QuotaStateCache;
  notices: NoticePort;
  notify: QuotaNotifyPort;
  emitWebhook: EmitWebhook;
  /** The most each send waits; default QUOTA_SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const allOk = (): QuotaStateLevels => ({ hosted_minutes_month: 'ok', queue_items_month: 'ok' });

const expiryOf = (periodEnd: Date): Date => new Date(periodEnd.getTime() + QUOTA_STATE_GRACE_MS);

/** Quota signals. */
export class QuotaSignals {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  readonly #sendTimeoutMs: number;

  constructor(private readonly deps: QuotaSignalsDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#sendTimeoutMs = deps.sendTimeoutMs ?? QUOTA_SEND_TIMEOUT_MS;
  }

  /** Evaluates the workspace at `now` and delivers what is due (see the module comment). */
  async evaluateQuota(
    workspaceId: string,
    now: Date = new Date(this.#clock()),
  ): Promise<QuotaTransition[]> {
    let decided: { transitions: QuotaTransition[]; cacheFailed: boolean } | null = null;
    for (let attempt = 0; decided === null; attempt += 1) {
      try {
        decided = await this.#decide(workspaceId, now, attempt === 0);
      } catch (err) {
        if (!(err instanceof StaleEntitlementsError)) throw err;
        this.#metrics.counter('quota_evaluations_rerun_total').inc();
      }
    }
    await this.deliver(workspaceId, now);
    if (decided.cacheFailed) {
      throw new QuotaStateCacheError('the quota:state hash could not be written');
    }
    return decided.transitions;
  }

  /** Steps 1 and 2; no transitions when the workspace is not evaluated. */
  async #decide(
    workspaceId: string,
    now: Date,
    checkRev: boolean,
  ): Promise<{ transitions: QuotaTransition[]; cacheFailed: boolean }> {
    const { deps } = this;
    const ent = await deps.entitlements.get(workspaceId);
    if (ent === null) {
      this.#skip(workspaceId, 'no_entitlements');
      return { transitions: [], cacheFailed: false };
    }
    const period = periodOf(now, subscribedPeriod(ent.period));
    if (ent.limits['relay_access'] !== true) {
      this.#skip(workspaceId, 'not_hosted');
      return {
        transitions: [],
        cacheFailed: !(await this.#writeCache(workspaceId, allOk(), period.end)),
      };
    }
    return deps.store.decide(workspaceId, async (tx) => {
      if (checkRev) {
        const again = await deps.entitlements.get(workspaceId);
        if (again?.rev !== ent.rev) throw new StaleEntitlementsError();
      }
      // After the lock: decisions run one at a time, so this reading is at least as new as the one
      // behind any level already claimed.
      const totals = await deps.counters.totals(workspaceId, period.start);
      const claimed = await tx.claimed(period.start);
      const levels = allOk();
      const transitions: QuotaTransition[] = [];
      for (const key of QUOTA_KEYS) {
        const raw = ent.limits[key];
        const limit = typeof raw === 'number' ? raw : null;
        const used = totals[QUOTA_METERS[key]];
        const rows: ClaimedLevel[] = claimed.filter((r) => r.limitKey === key);
        const current = highest(rows);
        if (limit !== null && used === undefined && current !== 'ok') {
          // Counters only grow within a period: a limit that signalled has a counter. Missing
          // data is never taken for a fall below the threshold.
          this.#skip(workspaceId, 'usage_missing', key);
          levels[key] = current;
          continue;
        }
        const target = levelOf(used ?? 0, limit);
        // Re-armed: levels above the target whose limit was removed or raised since the claim.
        const above = levelsToRearm(target);
        const rearm = rows
          .filter((r) => above.includes(r.level) && (limit === null || limit > r.limitValue))
          .map((r) => r.level);
        if (rearm.length > 0) {
          const rearmed = await tx.rearm(key, period.start, rearm);
          if (rearmed > 0) {
            this.#metrics.counter('quota_signals_rearmed_total', { limit: key }).inc(rearmed);
          }
        }
        const held = highest(rows.filter((r) => !rearm.includes(r.level)));
        if (limit !== null) {
          for (const level of levelsToClaim(held, target, limit)) {
            const won = await tx.claim({
              limitKey: key,
              periodStart: period.start,
              periodEnd: period.end,
              level,
              limitValue: limit,
            });
            if (won) this.#metrics.counter('quota_signals_total', { limit: key, level }).inc();
          }
        }
        // A target below what is still held comes from a reading lower than the claim's under a
        // limit no higher than the claim's, which growing counters never give: the stored level
        // stands.
        levels[key] = maxLevel(held, target);
        if (compareLevels(levels[key], current) !== 0) {
          transitions.push({
            limit: key,
            from: current,
            to: levels[key],
            pct: pctOf(used ?? 0, limit),
          });
        }
      }
      for (const t of transitions) {
        deps.logger?.info(
          { workspace_id: workspaceId, limit: t.limit, level: t.to },
          'quota.level_changed',
        );
      }
      // Before the commit: B080 and the relay see the new level as soon as it is decided.
      const cacheFailed = !(await this.#writeCache(workspaceId, levels, period.end));
      return { transitions, cacheFailed };
    });
  }

  /** Writes the hash; false (logged, and the hash dropped if possible) when it failed. */
  async #writeCache(
    workspaceId: string,
    levels: QuotaStateLevels,
    periodEnd: Date,
  ): Promise<boolean> {
    try {
      await this.deps.cache.write(workspaceId, levels, expiryOf(periodEnd));
      return true;
    } catch (err) {
      this.#metrics.counter('quota_state_cache_failures_total').inc();
      this.deps.logger?.warn(
        { workspace_id: workspaceId, error: err instanceof Error ? err.name : 'unknown' },
        'quota.state_cache_failed',
      );
      // Readers then go to SQL rather than read a level that is out of date.
      await this.deps.cache.drop(workspaceId).catch(() => undefined);
      return false;
    }
  }

  #skip(workspaceId: string, reason: string, limit?: MeteredKey): void {
    this.#metrics.counter('quota_evaluations_skipped_total', { reason }).inc();
    const fields =
      limit === undefined
        ? { workspace_id: workspaceId, reason }
        : { workspace_id: workspaceId, limit, reason };
    if (reason === 'not_hosted') this.deps.logger?.debug(fields, 'quota.evaluation_skipped');
    else this.deps.logger?.warn(fields, 'quota.evaluation_skipped');
  }

  /**
   * Delivers the workspace's signals that have a step to do (step 3); how many sends went out.
   * Another delivery of the workspace running at the same moment makes this one a no-op.
   */
  async deliver(workspaceId: string, now: Date = new Date(this.#clock())): Promise<number> {
    const result = await this.deps.store.deliver(workspaceId, (tx) => this.#deliverAll(tx, now));
    if (!result.ran) return 0;
    const { sent, failure } = result.value;
    if (failure !== null) throw new QuotaDeliveryError(failure.step, { cause: failure.err });
    return sent;
  }

  async #deliverAll(
    tx: SignalDeliveryTx,
    now: Date,
  ): Promise<{ sent: number; failure: { step: DeliveryStep; err: unknown } | null }> {
    const rows = await tx.pending();
    let sent = 0;
    let failure: { step: DeliveryStep; err: unknown } | null = null;
    const steps: {
      step: DeliveryStep;
      done: (r: SignalRow) => boolean;
      send: (r: SignalRow) => Promise<unknown>;
    }[] = [
      {
        step: 'notice',
        done: (r) => r.firedAt !== null,
        send: (r) => this.deps.notices.publish(r.workspaceId, noticeOf(r.level, r.periodEnd)),
      },
      {
        step: 'notification',
        done: (r) => r.notifiedAt !== null,
        send: (r) => this.deps.notify.publish(notificationOf(r)),
      },
      {
        step: 'webhook',
        done: (r) => r.webhookAt !== null,
        send: (r) => this.deps.emitWebhook(webhookOf(r)),
      },
    ];
    for (const { step, done, send } of steps) {
      // In order within a step: a failed `warn` holds back the `reached` after it.
      for (const row of rows) {
        if (done(row)) continue;
        if (row.periodEnd.getTime() <= now.getTime()) {
          // The period is over: nothing to tell about it any more.
          await tx.mark(row, step, now);
          continue;
        }
        try {
          await withTimeout(send(row), this.#sendTimeoutMs);
        } catch (err) {
          failure ??= { step, err };
          this.#metrics.counter('quota_signal_delivery_failures_total', { step }).inc();
          this.deps.logger?.warn(
            {
              workspace_id: row.workspaceId,
              limit: row.limitKey,
              level: row.level,
              step,
              error: err instanceof Error ? err.name : 'unknown',
            },
            'quota.signal_delivery_failed',
          );
          break;
        }
        // Committed at once: a later failure cannot undo it.
        await tx.mark(row, step, now);
        sent += 1;
        this.#metrics.counter('quota_signal_deliveries_total', { step }).inc();
      }
    }
    return { sent, failure };
  }

  /**
   * The workspace's level of each metered limit: the hash, else the stored signals of the current
   * period, written to the hash only if it is still missing (a decision that wrote it meanwhile is
   * newer than this reading). Unlimited limits and workspaces that are not hosted are `ok`.
   */
  async getQuotaState(workspaceId: string): Promise<QuotaStateLevels> {
    try {
      const cached = await this.deps.cache.read(workspaceId);
      if (cached?.hosted_minutes_month !== undefined && cached.queue_items_month !== undefined) {
        return {
          hosted_minutes_month: cached.hosted_minutes_month,
          queue_items_month: cached.queue_items_month,
        };
      }
    } catch (err) {
      this.deps.logger?.warn(
        { workspace_id: workspaceId, error: err instanceof Error ? err.name : 'unknown' },
        'quota.state_cache_unreadable',
      );
    }
    const levels = allOk();
    const ent = await this.deps.entitlements.get(workspaceId);
    if (ent === null) return levels;
    const period = periodOf(new Date(this.#clock()), subscribedPeriod(ent.period));
    if (ent.limits['relay_access'] === true) {
      const claimed = await this.deps.store.levels(workspaceId, period.start);
      for (const key of QUOTA_KEYS) {
        if (typeof ent.limits[key] === 'number') levels[key] = claimed[key] ?? 'ok';
      }
    }
    await this.#fillCache(workspaceId, levels, period.end);
    return levels;
  }

  /** Writes the hash if it is missing; a failure is logged (readers keep going to SQL). */
  async #fillCache(workspaceId: string, levels: QuotaStateLevels, periodEnd: Date): Promise<void> {
    try {
      await this.deps.cache.fill(workspaceId, levels, expiryOf(periodEnd));
    } catch (err) {
      this.#metrics.counter('quota_state_cache_failures_total').inc();
      this.deps.logger?.warn(
        { workspace_id: workspaceId, error: err instanceof Error ? err.name : 'unknown' },
        'quota.state_cache_failed',
      );
    }
  }

  /** CT-ENTITLEMENTS `warnings[]`: each limit at `warn` (pct 80) or `reached` (pct 100). */
  async getWarnings(workspaceId: string): Promise<{ limit: MeteredKey; pct: 80 | 100 }[]> {
    const levels = await this.getQuotaState(workspaceId);
    return QUOTA_KEYS.flatMap((limit) =>
      levels[limit] === 'ok'
        ? []
        : [{ limit, pct: levels[limit] === 'warn' ? (80 as const) : (100 as const) }],
    );
  }
}

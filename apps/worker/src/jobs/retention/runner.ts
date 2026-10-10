/**
 * The retention runner (B090): runs the policies, one after another, within one 30-minute budget.
 *
 * For each policy:
 *
 * 1. takes its Redis lock (lock.ts); a policy another run holds is reported `locked` and skipped;
 * 2. closes the policy's runs left unfinished by a worker that died (`interrupted`), then writes
 *    a `retention_runs` row (dry run or not);
 * 3. runs it with what is left of the budget, the dry-run flag and the brakes (policy.ts);
 * 4. finishes the row with the counts and why it stopped early, if it did: `fraction_exceeded`
 *    (the brake: nothing deleted), `budget_exceeded` (continues next run) or `failed` (an
 *    error: the other policies still run).
 *
 * Records `retention_purged_total{policy}`, `retention_run_duration_seconds{policy}`,
 * `retention_aborted_total{policy,reason}` (real runs only: a dry run that would abort is reported
 * in its row, not paged), `retention_policy_failures_total{policy}`, and keeps each policy's
 * backlog for the `retention_backlog{policy}` gauge (`observeRetentionBacklog`).
 *
 * Owns: the order, the budget and the report. Must not: delete anything itself, or log ids of
 * what policies delete.
 */
import { noopMetrics, type Logger, type Metrics, type TelemetryMetrics } from '@centcom/core';
import type { PolicyLock } from './lock.js';
import {
  RetentionAbort,
  RUN_BUDGET_MS,
  type RetentionPolicy,
  type RetentionResult,
} from './policy.js';

/** Why a policy's run stopped early (`retention_runs.aborted_reason`). */
export type RetentionAbortReason =
  'fraction_exceeded' | 'budget_exceeded' | 'failed' | 'interrupted';

/** The run reports (`retention_runs`). */
export interface RetentionRunStore {
  /** Closes the policy's unfinished runs as `interrupted` at `at`; how many there were. */
  closeInterrupted(policy: string, at: Date): Promise<number>;
  /** Writes a started run; its id. */
  start(policy: string, dryRun: boolean, at: Date): Promise<string>;
  /** Finishes the run `id`. */
  finish(
    id: string,
    result: {
      scanned: number;
      purged: number;
      skipped: number;
      abortedReason: RetentionAbortReason | null;
    },
    at: Date,
  ): Promise<void>;
}

/** The runner's settings (RETENTION_*). */
export interface RetentionRunConfig {
  dryRun: boolean;
  force: boolean;
  maxDeleteFraction: number;
}

/** What one policy's run came to. */
export interface PolicyReport {
  policy: string;
  outcome: 'done' | 'locked' | 'failed' | RetentionAbortReason;
  scanned: number;
  purged: number;
  skipped: number;
  backlog: number;
}

/** What the runner needs. */
export interface RetentionRunnerDeps {
  policies: readonly RetentionPolicy[];
  lock: PolicyLock;
  runs: RetentionRunStore;
  config: RetentionRunConfig;
  /** The run's budget; default RUN_BUDGET_MS. */
  budgetMs?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Upper bounds, in seconds, of `retention_run_duration_seconds`. */
export const RUN_DURATION_BUCKETS_S: readonly number[] = Object.freeze([
  0.1, 1, 10, 60, 300, 900, 1800,
]);

const ZERO: RetentionResult = { scanned: 0, purged: 0, skipped: 0 };

/** Runs the policies (see the module comment). */
export class RetentionRunner {
  readonly #backlog = new Map<string, number>();
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: RetentionRunnerDeps) {
    const ids = new Set<string>();
    for (const policy of deps.policies) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(policy.id) || ids.has(policy.id)) {
        throw new TypeError(`retention policy id ${policy.id} is malformed or used twice`);
      }
      ids.add(policy.id);
    }
    const fraction = deps.config.maxDeleteFraction;
    if (!(fraction > 0 && fraction <= 1)) {
      throw new RangeError('maxDeleteFraction must be in (0, 1]');
    }
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** The policies' ids, in run order. */
  get policyIds(): string[] {
    return this.deps.policies.map((p) => p.id);
  }

  /** Each policy's backlog after its last run (the `retention_backlog` gauge's reading). */
  backlog(): { value: number; labels: { policy: string } }[] {
    return [...this.#backlog].map(([policy, value]) => ({ value, labels: { policy } }));
  }

  /** Runs every policy, or only `policy`; one report per policy run. */
  async run(options: { policy?: string; now?: Date } = {}): Promise<PolicyReport[]> {
    const policies =
      options.policy === undefined
        ? this.deps.policies
        : this.deps.policies.filter((p) => p.id === options.policy);
    if (options.policy !== undefined && policies.length === 0) {
      throw new TypeError(`unknown retention policy ${options.policy}`);
    }
    const now = options.now ?? new Date(this.#clock());
    const deadline = this.#clock() + (this.deps.budgetMs ?? RUN_BUDGET_MS);
    const reports: PolicyReport[] = [];
    for (const policy of policies) reports.push(await this.#runOne(policy, now, deadline));
    return reports;
  }

  async #runOne(policy: RetentionPolicy, now: Date, deadline: number): Promise<PolicyReport> {
    const { deps } = this;
    const labels = { policy: policy.id };
    const held = await deps.lock.acquire(policy.id);
    if (held === null) {
      deps.logger?.warn({ policy: policy.id }, 'retention.policy_locked');
      return { policy: policy.id, outcome: 'locked', ...ZERO, backlog: 0 };
    }
    const started = this.#clock();
    let runId: string | null = null;
    try {
      const closed = await deps.runs.closeInterrupted(policy.id, new Date(started));
      if (closed > 0)
        deps.logger?.warn({ policy: policy.id, runs: closed }, 'retention.run_interrupted');
      runId = await deps.runs.start(policy.id, deps.config.dryRun, new Date(started));
      let result: RetentionResult;
      let reason: RetentionAbortReason | null = null;
      try {
        result = await policy.run({
          now,
          dryRun: deps.config.dryRun,
          budgetMs: Math.max(0, deadline - started),
          maxDeleteFraction: deps.config.maxDeleteFraction,
          force: deps.config.force,
          clock: this.#clock,
        });
        reason = result.stopped ?? null;
      } catch (err) {
        if (!(err instanceof RetentionAbort)) throw err;
        result = { ...ZERO, scanned: err.scanned };
        reason = err.reason;
        if (deps.config.dryRun) {
          deps.logger?.warn(
            { policy: policy.id, reason, dry_run: true },
            'retention.policy_aborted',
          );
        } else {
          this.#metrics.counter('retention_aborted_total', { ...labels, reason }).inc();
          deps.logger?.error({ policy: policy.id, reason }, 'retention.policy_aborted');
        }
      }
      await deps.runs.finish(runId, { ...result, abortedReason: reason }, new Date(this.#clock()));
      if (result.purged > 0) {
        this.#metrics.counter('retention_purged_total', labels).inc(result.purged);
      }
      const backlog = result.backlog ?? 0;
      this.#backlog.set(policy.id, backlog);
      deps.logger?.info(
        {
          policy: policy.id,
          scanned: result.scanned,
          purged: result.purged,
          skipped: result.skipped,
          backlog,
          dry_run: deps.config.dryRun,
          ...(reason === null ? {} : { reason }),
        },
        'retention.policy_ran',
      );
      return {
        policy: policy.id,
        outcome: reason ?? 'done',
        scanned: result.scanned,
        purged: result.purged,
        skipped: result.skipped,
        backlog,
      };
    } catch (err) {
      this.#metrics.counter('retention_policy_failures_total', labels).inc();
      deps.logger?.error(
        { policy: policy.id, error: err instanceof Error ? err.name : 'unknown' },
        'retention.policy_failed',
      );
      if (runId !== null) {
        await deps.runs
          .finish(runId, { ...ZERO, abortedReason: 'failed' }, new Date(this.#clock()))
          .catch(() => undefined);
      }
      return { policy: policy.id, outcome: 'failed', ...ZERO, backlog: 0 };
    } finally {
      this.#metrics
        .histogram('retention_run_duration_seconds', RUN_DURATION_BUCKETS_S)
        .observe((this.#clock() - started) / 1000, labels);
      await held.release();
    }
  }
}

/** Registers the `retention_backlog{policy}` gauge, read from the runner at each export. */
export function observeRetentionBacklog(
  metrics: Pick<TelemetryMetrics, 'gauge'>,
  runner: Pick<RetentionRunner, 'backlog'>,
): void {
  metrics.gauge('retention_backlog', () => runner.backlog());
}

/**
 * Telemetry retention (B085, CT-TELEMETRY rule 5): raw events for 90 days, daily aggregates after.
 * The worker's `telemetry-retention` jobs call these.
 *
 * - `rollup(day)` writes a day's counts (per type, and per string or boolean prop value) once;
 *   asked again, it does nothing. Without a day it rolls up every day before today that has a
 *   partition and no rollup yet (yesterday, and any day a missed run left).
 * - `drop(before)` rolls up any day it is about to drop that was not rolled up, then drops the
 *   partitions of days before `before`. Without a date it drops days older than 90 days, so a run
 *   after missed runs catches up on all of them.
 *
 * Owns: the order (roll up before drop). Must not: drop a day it has not rolled up.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { dayOf, type TelemetryRepository } from './repository.js';

const DAY_MS = 86_400_000;

/** What retention needs. */
export interface TelemetryRetentionDeps {
  repository: TelemetryRepository;
  /** TELEMETRY_RETENTION_DAYS. */
  retentionDays: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Rolls up and drops telemetry. */
export class TelemetryRetention {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: TelemetryRetentionDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Rolls `day` up (or every unrolled day before today); returns the days this call rolled up. */
  async rollup(day?: string): Promise<string[]> {
    const today = dayOf(new Date(this.#clock()));
    const days = day !== undefined ? [day] : await this.#unrolled((d) => d < today);
    const done: string[] = [];
    for (const d of days) {
      if (await this.deps.repository.rollup(d)) done.push(d);
    }
    if (done.length > 0) {
      this.#metrics.counter('telemetry_rollups_total').inc(done.length);
      this.deps.logger?.info({ days: done.length }, 'telemetry.rolled_up');
    }
    return done;
  }

  /** Drops days before `before` (default: older than the retention), rolling them up first. */
  async drop(before?: string): Promise<string[]> {
    const cutoff = before ?? dayOf(new Date(this.#clock() - this.deps.retentionDays * DAY_MS));
    for (const d of await this.#unrolled((x) => x < cutoff)) await this.deps.repository.rollup(d);
    const dropped = await this.deps.repository.drop(cutoff);
    if (dropped.length > 0) {
      this.#metrics.counter('telemetry_partitions_dropped_total').inc(dropped.length);
      this.deps.logger?.info({ partitions: dropped.length }, 'telemetry.partitions_dropped');
    }
    return dropped;
  }

  async #unrolled(keep: (day: string) => boolean): Promise<string[]> {
    const rolled = new Set(await this.deps.repository.rolledUpDays());
    return (await this.deps.repository.partitionDays()).filter((d) => keep(d) && !rolled.has(d));
  }
}

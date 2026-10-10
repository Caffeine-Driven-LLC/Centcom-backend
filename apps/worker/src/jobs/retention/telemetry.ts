/**
 * Telemetry retention, reported read-only (B090 scope_out: "Telemetry retention (owned by B085;
 * reported here read-only)"): B085's own job drops raw telemetry older than 90 days (CT-TELEMETRY
 * rule 5) by day partition. This policy deletes nothing: it counts the raw events still stored
 * past those 90 days, so the run report (`retention_runs.scanned`) and a warning show when B085's
 * drops fall behind.
 *
 * Owns: the report. Must not: delete or read telemetry contents.
 */
import type { Logger } from '@centcom/core';
import type { RetentionContext, RetentionPolicy, RetentionResult } from './policy.js';

/** CT-TELEMETRY rule 5: raw events are kept 90 days. */
export const TELEMETRY_RAW_DAYS = 90;

/** What the report reads. */
export interface TelemetryReportStore {
  /** Raw telemetry events of days more than `days` before `now`. */
  overdue(now: Date, days: number): Promise<number>;
}

/** The read-only telemetry report. */
export function createTelemetryReportPolicy(deps: {
  store: TelemetryReportStore;
  logger?: Logger;
}): RetentionPolicy {
  return {
    id: 'telemetry',
    owner: 'B085',
    async run(ctx: RetentionContext): Promise<RetentionResult> {
      const overdue = await deps.store.overdue(ctx.now, TELEMETRY_RAW_DAYS);
      if (overdue > 0) {
        deps.logger?.warn({ policy: 'telemetry', events: overdue }, 'retention.telemetry_overdue');
      }
      return { scanned: overdue, purged: 0, skipped: 0 };
    },
  };
}

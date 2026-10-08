/**
 * Component status rules (B086): the overall status is the worst component's, and a probed
 * component moves with hysteresis so a flapping probe does not flap the feed:
 *
 * - one failure: `degraded`; three in a row: `major_outage`;
 * - back to `operational` only after two successes in a row.
 *
 * Owns: the order of statuses and the hysteresis. Must not: read anything (pure).
 */

/** A component's or the feed's status (CT-STATUS). */
export type ComponentStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage';

/** Least to most severe. */
export const STATUS_ORDER: readonly ComponentStatus[] = Object.freeze([
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
]);

/** Failures in a row that make a component `major_outage`. */
export const FAILURES_FOR_OUTAGE = 3;
/** Successes in a row that bring a component back to `operational`. */
export const SUCCESSES_FOR_RECOVERY = 2;

/** The worst of `statuses`; `operational` when there are none. */
export function worstOf(statuses: Iterable<ComponentStatus>): ComponentStatus {
  let worst = 0;
  for (const s of statuses) worst = Math.max(worst, STATUS_ORDER.indexOf(s));
  return STATUS_ORDER[worst] ?? 'operational';
}

/** A probed component's state between rounds. */
export interface ProbeState {
  status: ComponentStatus;
  failures: number;
  successes: number;
}

/** The state of a component never probed. */
export const INITIAL_PROBE_STATE: ProbeState = Object.freeze({
  status: 'operational',
  failures: 0,
  successes: 0,
});

/** The state after a probe round that succeeded (`ok`) or not. */
export function nextProbeState(state: ProbeState, ok: boolean): ProbeState {
  if (ok) {
    const successes = state.successes + 1;
    const status =
      state.status === 'operational' || successes >= SUCCESSES_FOR_RECOVERY
        ? 'operational'
        : state.status;
    return { status, failures: 0, successes };
  }
  const failures = state.failures + 1;
  const status =
    failures >= FAILURES_FOR_OUTAGE || state.status === 'major_outage'
      ? 'major_outage'
      : 'degraded';
  return { status, failures, successes: 0 };
}

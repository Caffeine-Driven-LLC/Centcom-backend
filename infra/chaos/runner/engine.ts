/**
 * The chaos engine (B096): runs a scenario against a stack through two ports, an Injector (what breaks
 * and heals) and a Prober (what is observed). Steady state first (a scenario that cannot even start
 * healthy is reported, not run); then each fault, with the `during` checks polled while it is active
 * and `abort_if` checked every second (a true one heals at once and fails the scenario); then heal
 * and the `expect` checks. Healing always runs, also after an error.
 *
 * Owns: the order of events and the verdict. Must not: call Docker or HTTP itself.
 */
import type { Check, Fault, Scenario } from './scenario.js';

export interface Injector {
  /** Applies `fault` to the stack. */
  apply(fault: Fault): Promise<void>;
  /** Undoes `fault` (start, unpause); safe to call when nothing is wrong. */
  heal(fault: Fault): Promise<void>;
}

export interface Prober {
  /** True when `check` holds right now. */
  holds(check: Check): Promise<boolean>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface ScenarioReport {
  scenario: string;
  passed: boolean;
  steady_state_before: Record<string, boolean>;
  during: Record<string, number | null>;
  after: Record<string, number | null>;
  violations: string[];
}

const POLL_MS = 500;

/** Milliseconds until `check` held (polling for its `within_s`), or null if it never did. */
async function until(check: Check, prober: Prober, clock: Clock): Promise<number | null> {
  const start = clock.now();
  const limit = (check.within_s ?? 0) * 1000;
  for (;;) {
    if (await prober.holds(check).catch(() => false)) return clock.now() - start;
    if (clock.now() - start >= limit) return null;
    await clock.sleep(POLL_MS);
  }
}

/** Runs one scenario. Never throws: an error becomes a violation, and the stack is healed. */
export async function runScenario(
  scenario: Scenario,
  injector: Injector,
  prober: Prober,
  clock: Clock = realClock,
): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    scenario: scenario.id,
    passed: false,
    steady_state_before: {},
    during: {},
    after: {},
    violations: [],
  };
  const applied: Fault[] = [];
  try {
    for (const check of scenario.steady_state) {
      const ok = (await until(check, prober, clock)) !== null;
      report.steady_state_before[check.name] = ok;
      if (!ok)
        report.violations.push(
          `steady state before: "${check.name}" does not hold; nothing was injected`,
        );
    }
    if (report.violations.length > 0) return report;

    let aborted = false;
    for (const fault of scenario.inject) {
      applied.push(fault); // before applying: a half-applied fault must be healed too
      await injector.apply(fault);
      const t0 = clock.now();
      const end = t0 + fault.duration_s * 1000;
      const label = `${fault.fault} ${fault.service}`;
      const pending = [...(scenario.during ?? [])];
      for (;;) {
        for (const check of [...pending]) {
          if (await prober.holds(check).catch(() => false)) {
            report.during[check.name] = clock.now() - t0;
            pending.splice(pending.indexOf(check), 1);
          }
        }
        for (const check of scenario.abort_if ?? []) {
          if (await prober.holds(check).catch(() => false)) {
            report.violations.push(
              `abort condition "${check.name}" became true during "${label}"; healed early`,
            );
            aborted = true;
          }
        }
        if (aborted || clock.now() >= end) break;
        await clock.sleep(Math.min(POLL_MS, Math.max(1, end - clock.now())));
      }
      for (const check of pending) {
        report.during[check.name] = null;
        report.violations.push(
          `during "${label}": "${check.name}" never held while the fault was active`,
        );
      }
      await injector.heal(fault);
      applied.pop();
      if (aborted) break;
    }

    if (!aborted) {
      for (const check of scenario.expect) {
        const took = await until(check, prober, clock);
        report.after[check.name] = took;
        if (took === null)
          report.violations.push(
            `after healing: "${check.name}" did not hold within ${check.within_s ?? 0} s`,
          );
      }
    }
  } catch (err) {
    report.violations.push(`error: ${(err as Error).message}`);
  } finally {
    // Whatever is still applied is undone, so a failed scenario never leaves the stack broken.
    for (const fault of applied.reverse()) await injector.heal(fault).catch(() => undefined);
  }
  report.passed = report.violations.length === 0;
  return report;
}

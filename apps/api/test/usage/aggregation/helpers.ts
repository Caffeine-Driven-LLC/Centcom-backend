/**
 * Fixtures for the aggregation tests (B075): an in-memory usage_event table and counter store with
 * the Postgres ones' rules (one aggregation at a time, the cursor moving with the counters, a
 * crossing claim undone when its `then` throws), a fake relay, and B069's entitlement service
 * (its test harness) wired to B075's reader, quota service and aggregator.
 */
import { newId } from '@centcom/contracts';
import type { SubscriptionState } from '../../../src/modules/entitlements/ports.js';
import {
  UsageAggregator,
  type RelayCounterPort,
  type RelayMetric,
} from '../../../src/modules/usage/aggregate.js';
import {
  mergeDeltas,
  type AggregateTx,
  type CounterDelta,
  type CounterMetric,
  type CounterStore,
  type Crossing,
  type EventSum,
  type QuotaKey,
} from '../../../src/modules/usage/counters.js';
import type { UsagePeriod } from '../../../src/modules/usage/period.js';
import { QuotaService, type QuotaCrossed } from '../../../src/modules/usage/quota.js';
import { createUsageReader } from '../../../src/modules/usage/reader.js';
import { serviceHarness } from '../../entitlements/helpers.js';

export { newId };

/** A raw usage event as usage_event holds it. */
export interface RawEvent {
  workspaceId: string;
  type: CounterMetric;
  qty: number;
  at: Date;
  receivedAt: Date;
}

/** The in-memory counter store, by the Postgres one's rules. */
export class MemoryCounterStore implements CounterStore {
  readonly events: RawEvent[] = [];
  readonly counters = new Map<string, number>();
  readonly crossingRows = new Map<string, Crossing>();
  highWater = new Date(0);
  /** When set, `aggregate` throws it after reading (a crash mid-run). */
  crash: Error | undefined;
  #turn: Promise<unknown> = Promise.resolve();

  static key = (ws: string, periodStart: Date, metric: string): string =>
    `${ws}|${periodStart.toISOString()}|${metric}`;

  /** The counter of `metric` for `ws` in the period starting `periodStart`. */
  counter(ws: string, periodStart: Date, metric: CounterMetric): number {
    return this.counters.get(MemoryCounterStore.key(ws, periodStart, metric)) ?? 0;
  }

  #apply(deltas: readonly CounterDelta[], into: Map<string, number>): void {
    for (const d of mergeDeltas(deltas)) {
      const key = MemoryCounterStore.key(d.workspaceId, d.periodStart, d.metric);
      into.set(key, (into.get(key) ?? 0) + d.amount);
    }
  }

  aggregate<T>(fn: (tx: AggregateTx) => Promise<T>): Promise<T> {
    const run = this.#turn.then(async () => {
      // Work on copies; commit only if `fn` succeeds.
      const counters = new Map(this.counters);
      let highWater = this.highWater;
      const tx: AggregateTx = {
        highWater: () => Promise.resolve(highWater),
        eventSums: (after, upTo) => {
          const sums = new Map<string, EventSum>();
          for (const e of this.events) {
            if (e.receivedAt <= after || e.receivedAt > upTo) continue;
            const second = new Date(Math.floor(e.at.getTime() / 1000) * 1000);
            const key = `${e.workspaceId}|${e.type}|${second.toISOString()}`;
            const sum = sums.get(key) ?? {
              workspaceId: e.workspaceId,
              type: e.type,
              second,
              total: 0,
              events: 0,
            };
            sum.total += e.qty;
            sum.events += 1;
            sums.set(key, sum);
          }
          if (this.crash !== undefined) return Promise.reject(this.crash);
          return Promise.resolve([...sums.values()]);
        },
        add: (deltas) => {
          this.#apply(deltas, counters);
          return Promise.resolve();
        },
        setHighWater: (at) => {
          highWater = at;
          return Promise.resolve();
        },
      };
      const result = await fn(tx);
      this.counters.clear();
      for (const [k, v] of counters) this.counters.set(k, v);
      this.highWater = highWater;
      return result;
    });
    this.#turn = run.catch(() => undefined);
    return run;
  }

  add(deltas: readonly CounterDelta[]): Promise<void> {
    this.#apply(deltas, this.counters);
    return Promise.resolve();
  }

  totals(workspaceId: string, periodStart: Date): Promise<Partial<Record<CounterMetric, number>>> {
    const out: Partial<Record<CounterMetric, number>> = {};
    const prefix = `${workspaceId}|${periodStart.toISOString()}|`;
    for (const [k, v] of this.counters) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length) as CounterMetric] = v;
    }
    return Promise.resolve(out);
  }

  crossings(workspaceId: string, periodStart: Date): Promise<Crossing[]> {
    const prefix = `${workspaceId}|${periodStart.toISOString()}|`;
    return Promise.resolve(
      [...this.crossingRows].filter(([k]) => k.startsWith(prefix)).map(([, c]) => ({ ...c })),
    );
  }

  async claimCrossing(
    workspaceId: string,
    periodStart: Date,
    limitKey: QuotaKey,
    pct: 80 | 100,
    at: Date,
    then: () => Promise<void>,
  ): Promise<boolean> {
    const key = MemoryCounterStore.key(workspaceId, periodStart, limitKey);
    const row = this.crossingRows.get(key) ?? { limitKey, crossed80At: null, crossed100At: null };
    const field = pct === 80 ? 'crossed80At' : 'crossed100At';
    if (row[field] !== null) return false;
    await then();
    this.crossingRows.set(key, { ...row, [field]: at });
    return true;
  }
}

/** A fake relay: counts waiting per workspace and metric; `down` makes it unreachable. */
export class FakeRelay implements RelayCounterPort {
  readonly waiting = new Map<string, Partial<Record<RelayMetric, number>>>();
  down = false;

  record(workspaceId: string, metric: RelayMetric, amount: number): void {
    const w = this.waiting.get(workspaceId) ?? {};
    w[metric] = (w[metric] ?? 0) + amount;
    this.waiting.set(workspaceId, w);
  }

  workspaces(): Promise<string[]> {
    if (this.down) return Promise.reject(new Error('relay down'));
    return Promise.resolve([...this.waiting.keys()]);
  }

  take(workspaceId: string, metric: RelayMetric): Promise<number> {
    if (this.down) return Promise.reject(new Error('relay down'));
    const w = this.waiting.get(workspaceId) ?? {};
    const amount = w[metric] ?? 0;
    w[metric] = 0;
    return Promise.resolve(amount);
  }
}

/** The whole chain over memory: B069's service with B075's reader, quota service and aggregator. */
export function usageHarness() {
  const counters = new MemoryCounterStore();
  const relay = new FakeRelay();
  const harness = serviceHarness({ usage: createUsageReader(counters, () => clock.now) });
  const { clock } = harness;
  const emitted: QuotaCrossed[] = [];
  const bumps: string[] = [];
  let failBump = false;
  const rev = {
    bumpRev: async (workspaceId: string, reason: 'usage_warning') => {
      bumps.push(workspaceId);
      if (failBump) throw new Error('entitlements down');
      return harness.service.bumpRev(workspaceId, reason);
    },
  };
  const quota = new QuotaService({
    counters,
    entitlements: harness.service,
    rev,
    events: {
      emit: (e) => {
        emitted.push(e);
        return Promise.resolve();
      },
    },
    clock: clock.read,
  });
  const periods = {
    async period(workspaceId: string): Promise<UsagePeriod | null> {
      const ent = await harness.service.get(workspaceId);
      return ent?.period === undefined
        ? null
        : { start: new Date(ent.period.start), end: new Date(ent.period.end) };
    },
  };
  const aggregator = new UsageAggregator({ counters, periods, relay, quota, clock: clock.read });
  return {
    ...harness,
    counters,
    relay,
    quota,
    aggregator,
    emitted,
    bumps,
    failBumps: (fail: boolean) => {
      failBump = fail;
    },
    /** Subscribes `ws` to `plan`, active, in `period`. */
    subscribe: (ws: string, plan: 'pro' | 'team', period: UsagePeriod) =>
      harness.service.applySubscriptionState(ws, {
        plan,
        status: 'active',
        period,
        past_due_since: null,
        addon_seats: 0,
      } satisfies SubscriptionState),
    /** Adds raw events received at `receivedAt` (default the clock). */
    ingest: (
      ws: string,
      type: CounterMetric,
      qty: number,
      at: Date,
      receivedAt = new Date(clock.now),
    ) => {
      counters.events.push({ workspaceId: ws, type, qty, at, receivedAt });
    },
  };
}

/** Small statistics helpers for the load driver (B095). */

/** Collects numbers and answers percentiles; a window of 100 000 values sorts in a few ms. */
export class Samples {
  private values: number[] = [];

  add(value: number): void {
    this.values.push(value);
  }

  get count(): number {
    return this.values.length;
  }

  /** The `p`-th percentile (0..100) by nearest rank; 0 when empty. */
  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    this.values.sort((a, b) => a - b);
    const rank = Math.min(
      this.values.length - 1,
      Math.max(0, Math.ceil((p / 100) * this.values.length) - 1),
    );
    return this.values[rank] ?? 0;
  }

  max(): number {
    let max = 0;
    for (const v of this.values) if (v > max) max = v;
    return max;
  }

  mean(): number {
    if (this.values.length === 0) return 0;
    let sum = 0;
    for (const v of this.values) sum += v;
    return sum / this.values.length;
  }

  reset(): void {
    this.values = [];
  }
}

/** Rounds to `digits` decimals. */
export const round = (value: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Measures how late timers fire: the load generator's own saturation (event-loop lag). */
export class LagMonitor {
  readonly lag = new Samples();
  private timer: NodeJS.Timeout | undefined;
  private expected = 0;

  start(intervalMs = 100): void {
    this.expected = performance.now() + intervalMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.lag.add(Math.max(0, now - this.expected));
      this.expected = now + intervalMs;
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * A mergeable latency histogram (B095): log-spaced buckets from 0.05 ms to about 100 s with about
 * 1.5 % resolution. Generator processes each keep one and send the counts to the coordinator, which
 * merges them; a percentile is the upper edge of its bucket, so it never under-reports.
 */
const MIN_MS = 0.05;
const GROWTH = 1.03;
const BUCKETS = 640;

const edge = (i: number): number => MIN_MS * GROWTH ** i;

export class Histogram {
  readonly counts: number[];
  total = 0;
  max = 0;

  constructor(counts?: readonly number[]) {
    this.counts = counts === undefined ? new Array<number>(BUCKETS).fill(0) : [...counts];
    this.total = this.counts.reduce((a, b) => a + b, 0);
  }

  add(ms: number): void {
    const i =
      ms <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms / MIN_MS) / Math.log(GROWTH)));
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.total += 1;
    if (ms > this.max) this.max = ms;
  }

  merge(other: Histogram): void {
    other.counts.forEach((c, i) => (this.counts[i] = (this.counts[i] ?? 0) + c));
    this.total += other.total;
    this.max = Math.max(this.max, other.max);
  }

  /** The `p`-th percentile (0..100) in ms; 0 when empty. */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const rank = Math.ceil((p / 100) * this.total);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      seen += this.counts[i] ?? 0;
      if (seen >= rank) return Math.min(edge(i), this.max || edge(i));
    }
    return this.max;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
    this.max = 0;
  }

  toJSON(): { counts: number[]; max: number } {
    return { counts: this.counts, max: this.max };
  }

  static from(data: { counts: number[]; max: number }): Histogram {
    const h = new Histogram(data.counts);
    h.max = data.max;
    return h;
  }
}

/**
 * The per-member limit on sequenced frames (B041, CT-WS-ENVELOPE "Limits": 30/s sustained, burst
 * 100): a token bucket for each (session, member) on this node, shared by the member's
 * connections, refilled continuously at `rate` per second up to `burst`. A frame without a token
 * is dropped, never queued. A member is violating while its frames keep being dropped; one who
 * stays within the limit for SLOW_DOWN_MS (the pause `sys.slow_down` asks for) starts afresh, and
 * VIOLATION_CLOSE_MS of continuous violation ends in close 4429.
 *
 * Tokens are counted in thousandths, so whole-millisecond clocks refill exactly.
 *
 * Owns: the buckets. Must not: queue a frame, or keep a bucket after its member's last connection.
 */

/** `sys.slow_down`'s `p.for_ms`, and the quiet time that ends a violation. */
export const SLOW_DOWN_MS = 1_000;
/** Continuous violation for this long closes the connection (4429). */
export const VIOLATION_CLOSE_MS = 5_000;

/** What to do with one sequenced frame. */
export type RateDecision = 'pass' | 'drop' | 'close';

interface Bucket {
  /** Thousandths of a token. */
  milli: number;
  at: number;
  violatingSince: number | null;
  lastDrop: number;
  users: number;
}

/** Buckets by (session, member) key. */
export class MemberRateLimiter {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #buckets = new Map<string, Bucket>();

  /** `rate` frames per second sustained, `burst` at once. */
  constructor(config: { rate: number; burst: number }) {
    if (!Number.isSafeInteger(config.rate) || config.rate < 1) {
      throw new TypeError('MemberRateLimiter: rate must be a positive integer');
    }
    if (!Number.isSafeInteger(config.burst) || config.burst < 1) {
      throw new TypeError('MemberRateLimiter: burst must be a positive integer');
    }
    this.#rate = config.rate;
    this.#capacity = config.burst * 1000;
  }

  /** The key of member `member` in session `sid`. */
  static key(sid: string, member: string): string {
    return `${sid} ${member}`;
  }

  /** A connection of `key` starts using its bucket (full for a new one). */
  attach(key: string, now: number): void {
    const bucket = this.#buckets.get(key);
    if (bucket !== undefined) bucket.users += 1;
    else {
      this.#buckets.set(key, {
        milli: this.#capacity,
        at: now,
        violatingSince: null,
        lastDrop: 0,
        users: 1,
      });
    }
  }

  /** A connection of `key` closed; its bucket goes with the last one. */
  detach(key: string): void {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return;
    bucket.users -= 1;
    if (bucket.users <= 0) this.#buckets.delete(key);
  }

  /** Spends a token of `key` at `now`, or says whether to drop the frame or close. */
  take(key: string, now: number): RateDecision {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return 'pass';
    if (now > bucket.at) {
      bucket.milli = Math.min(this.#capacity, bucket.milli + (now - bucket.at) * this.#rate);
      bucket.at = now;
    }
    if (bucket.milli >= 1000) {
      bucket.milli -= 1000;
      return 'pass';
    }
    if (bucket.violatingSince === null || now - bucket.lastDrop > SLOW_DOWN_MS) {
      bucket.violatingSince = now;
    }
    bucket.lastDrop = now;
    return now - bucket.violatingSince >= VIOLATION_CLOSE_MS ? 'close' : 'drop';
  }

  /** Buckets held. */
  get size(): number {
    return this.#buckets.size;
  }
}

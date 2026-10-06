/**
 * Secret values (B004): a wrapper whose every string, JSON and inspect form is `[redacted]`, so a
 * secret cannot leak through logs, error messages or serialisation by accident.
 *
 * Owns: the Secret type and the zod helper that produces it. Must not: expose the value except
 * through `reveal()`, or keep it in an enumerable property (structuredClone and spreads copy those).
 */
import { inspect } from 'node:util';
import { z } from 'zod';

/** What every printable form of a Secret shows. */
export const REDACTED = '[redacted]';

/** A value that must never be logged or serialised. Call `reveal()` at the single point of use. */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
    Object.freeze(this);
  }

  /** The wrapped value. Use it only where it is needed (e.g. a database driver), never in logs. */
  reveal(): T {
    return this.#value;
  }

  toString(): typeof REDACTED {
    return REDACTED;
  }

  toJSON(): typeof REDACTED {
    return REDACTED;
  }

  /** Template literals, `String()` and `+` concatenation. */
  [Symbol.toPrimitive](): typeof REDACTED {
    return REDACTED;
  }

  /** util.inspect, console.log and structured loggers that use inspect. */
  [inspect.custom](): typeof REDACTED {
    return REDACTED;
  }
}

/**
 * A zod schema for a secret string: validates the raw string with `inner` (default: non-empty),
 * then wraps it in a Secret. Marked `secret` for the generated config docs.
 */
export function secretString(inner: z.ZodType<string, string> = z.string().min(1)) {
  return inner.transform((value) => new Secret(value)).meta({ secret: true });
}

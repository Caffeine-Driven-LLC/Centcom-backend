/**
 * Money (CT-IDS): integer minor units plus an ISO-4217 code, `{"amount": 1900, "currency": "USD"}`.
 * Never floats. The type is the OpenAPI `Money` component; v1 currencies are USD and EUR.
 *
 * Owns: constructing and checking Money values. Must not: accept fractional or unsafe integer
 * amounts, or currencies outside the contract.
 */
import type { Money } from './generated/api.js';
import { validate, type Result } from './validate.js';

export type { Money };

/** An ISO-4217 code allowed by the contract. */
export type Currency = Money['currency'];

/**
 * Checks an untrusted value against the contract's Money schema and requires a safe integer
 * amount (the schema's `integer` alone would let 1e21 through). Never throws.
 */
export function parseMoney(value: unknown): Result<Money> {
  const result = validate('api/Money', value);
  if (!result.ok) return result;
  if (!Number.isSafeInteger(result.value.amount)) {
    return { ok: false, errors: [{ pointer: '/amount', code: 'out_of_range', detail: 'must be a safe integer of minor units' }] };
  }
  return result;
}

/** True if `value` is valid Money. */
export function isMoney(value: unknown): value is Money {
  return parseMoney(value).ok;
}

/**
 * Builds Money from trusted code. Throws RangeError for a non-safe-integer amount or a currency
 * outside the contract (a programming error).
 */
export function money(amount: number, currency: Currency): Money {
  const result = parseMoney({ amount, currency });
  if (!result.ok) throw new RangeError(`invalid money: ${result.errors.map((e) => `${e.pointer} ${e.detail}`).join('; ')}`);
  return result.value;
}

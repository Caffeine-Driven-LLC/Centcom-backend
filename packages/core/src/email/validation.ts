/**
 * Email input rules (B032): recipient addresses, sender lines, text that ends up in headers or
 * bodies, and links. Anything that could inject a header (CR or LF) is refused before it reaches a
 * provider; addresses are lower-cased and at most 254 characters.
 *
 * Owns: the checks and the problems they raise. Must not: echo a refused value in a problem (it may
 * be an address or carry a token).
 */
import { hasControlChars } from '@centcom/contracts';
import { validationFailed, type FieldError } from '../errors/app-error.js';

/** The longest address (RFC 5321's path limit, as the card asks). */
export const MAX_ADDRESS_LENGTH = 254;
/** The longest subject a rendered email may have. */
export const MAX_SUBJECT_LENGTH = 150;
/** The longest text parameter a template accepts. */
export const MAX_TEXT_PARAM_LENGTH = 200;
/** The longest link a template accepts. */
export const MAX_URL_LENGTH = 2048;

/** The user-facing details of email problems (GUIDELINES §3.4: one message table). */
export const EMAIL_DETAILS = Object.freeze({
  invalid: 'The email could not be sent: some of its fields are not valid.',
  rateLimited: 'Too many emails of this kind to this address. Try again later.',
  unavailable: 'Email cannot be queued right now. Try again shortly.',
} as const);

/** A pragmatic address shape: a local part and a dotted domain, no spaces, quotes or brackets. */
const ADDRESS =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LINE_BREAK = /[\r\n]/;

/** A 422 for one field. */
const invalid = (pointer: string, code: string, detail: string): never => {
  throw validationFailed([{ pointer, code, detail }], EMAIL_DETAILS.invalid);
};

/** True if `value` holds CR or LF (a header injection attempt in any header-bound field). */
export const hasLineBreak = (value: string): boolean => LINE_BREAK.test(value);

/** True if `value` is one plain address of at most 254 characters (any case). */
export const isAddress = (value: string): boolean =>
  value.length <= MAX_ADDRESS_LENGTH && ADDRESS.test(value.toLowerCase());

/**
 * The recipient, lower-cased. Throws a 422 at `pointer` for a line break, more than 254
 * characters, or anything that is not one plain address.
 */
export function normalizeAddress(value: unknown, pointer = '/to'): string {
  if (typeof value !== 'string') return invalid(pointer, 'invalid_type', 'must be a string');
  if (hasLineBreak(value))
    return invalid(pointer, 'invalid_format', 'must not contain line breaks');
  const address = value.trim().toLowerCase();
  if (address.length > MAX_ADDRESS_LENGTH) {
    return invalid(pointer, 'too_long', `must be at most ${MAX_ADDRESS_LENGTH} characters`);
  }
  if (!ADDRESS.test(address)) return invalid(pointer, 'invalid_format', 'must be an email address');
  return address;
}

/**
 * A sender line: `address` or `Display Name <address>`, without line breaks or control characters.
 * Throws a TypeError (it comes from configuration, which reports it at startup).
 */
export function checkSender(value: string): string {
  const match = /^(?:([^<>"\r\n]{1,100}) <([^<>\s]+)>|([^<>\s]+))$/.exec(value);
  const address = match?.[2] ?? match?.[3];
  // The pattern keeps line breaks out of both the name and the address.
  if (address === undefined || hasControlChars(value) || !isAddress(address)) {
    throw new TypeError('the sender must be `address` or `Display Name <address>`');
  }
  return value;
}

/** A text parameter: a string of 1 to 200 characters without line breaks or control characters. */
export function checkTextParam(value: unknown, pointer: string, issues: FieldError[]): void {
  if (typeof value !== 'string') {
    issues.push({ pointer, code: 'invalid_type', detail: 'must be a string' });
  } else if (value.length === 0 || value.length > MAX_TEXT_PARAM_LENGTH) {
    issues.push({
      pointer,
      code: 'invalid_format',
      detail: `must be 1 to ${MAX_TEXT_PARAM_LENGTH} characters`,
    });
  } else if (hasLineBreak(value) || hasControlChars(value)) {
    issues.push({
      pointer,
      code: 'invalid_format',
      detail: 'must not contain line breaks or control characters',
    });
  }
}

/**
 * A link parameter: an absolute https URL (http only for localhost, in development), at most 2048
 * characters, used exactly as given: the renderer adds no tracking and no redirect.
 */
export function checkUrlParam(value: unknown, pointer: string, issues: FieldError[]): void {
  let url: URL | undefined;
  if (typeof value === 'string' && value.length <= MAX_URL_LENGTH && !hasLineBreak(value)) {
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
  }
  const local = url?.hostname === 'localhost' || url?.hostname === '127.0.0.1';
  const allowed =
    url !== undefined &&
    url.username === '' &&
    url.password === '' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && local));
  if (!allowed) {
    issues.push({ pointer, code: 'invalid_format', detail: 'must be an https link' });
  }
}

/** A date parameter: a valid Date. */
export function checkDateParam(value: unknown, pointer: string, issues: FieldError[]): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    issues.push({ pointer, code: 'invalid_type', detail: 'must be a date' });
  }
}

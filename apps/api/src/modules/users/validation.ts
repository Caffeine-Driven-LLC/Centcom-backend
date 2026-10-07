/**
 * User field rules (B013), applied before anything reaches the database: e-mail (CT-IDS: NFC,
 * lower case, at most 254, one `@` with something on both sides and no blanks), display name
 * (1-40 code points after NFC, no control characters), locale (a BCP 47 tag with a 2-3 letter
 * language, stored canonically: `en-gb` becomes `en-GB`), and the avatar slot (1-64 characters, or
 * null). A bad value is a 422 `validation_failed` AppError whose `errors[]` point at the field.
 *
 * Owns: the checks and the shape of their errors. Must not: put the rejected value in an error
 * (CT-ERR: no values copied from the request), or call the database.
 */
import {
  checkName,
  hasControlChars,
  normaliseEmail,
  normaliseText,
  type ValidationIssue,
} from '@centcom/contracts';
import { validationFailed, type FieldError } from '@centcom/core';
import type { ProfilePatch } from '@centcom/db';

/** Locale tags are at most this long (the column's check). */
export const MAX_LOCALE_LENGTH = 35;
/** Avatar slot identifiers are 1-64 characters. */
export const MAX_AVATAR_LENGTH = 64;
/** The locale of a user who has not chosen one. */
export const DEFAULT_LOCALE = 'en';

/** What the users table's check accepts (B008), after canonicalisation. */
const LOCALE_SHAPE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;
/** ISO 639 languages are 2-3 letters; BCP 47's 5-8 letter subtags are for languages never registered. */
const LANGUAGE_SUBTAG = /^[A-Za-z]{2,3}(-|$)/;
/** The table's e-mail check: one `@`, something on each side, no white space. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

/** Field errors gathered by `check*`. */
type Issues = FieldError[];

const fieldError = (pointer: string, code: string, detail: string): FieldError => ({
  pointer,
  code,
  detail,
});

/** Prefixes the pointers of contract issues (`''` → `/display_name`). */
const at = (pointer: string, issues: readonly ValidationIssue[]): Issues =>
  issues.map((issue) => fieldError(`${pointer}${issue.pointer}`, issue.code, issue.detail));

/** Throws one validation AppError for all `issues`, if there are any. */
function throwIfAny(issues: Issues): void {
  if (issues.length > 0) throw validationFailed(issues, 'Some fields are not valid.');
}

/** The e-mail address as stored (NFC, lower case), or the issues. */
export function checkEmail(value: unknown, pointer = '/email'): { value?: string; issues: Issues } {
  const result = normaliseEmail(value);
  if (!result.ok) return { issues: at(pointer, result.errors) };
  if (!EMAIL_SHAPE.test(result.value)) {
    return { issues: [fieldError(pointer, 'invalid_format', 'must be an e-mail address')] };
  }
  return { value: result.value, issues: [] };
}

/** The display name, NFC-normalised, or the issues. */
export function checkDisplayName(
  value: unknown,
  pointer = '/display_name',
): { value?: string; issues: Issues } {
  const result = checkName('displayName', value);
  return result.ok ? { value: result.value, issues: [] } : { issues: at(pointer, result.errors) };
}

/** The locale in canonical form (`en-gb` → `en-GB`, `eng` → `en`), or the issues. */
export function checkLocale(
  value: unknown,
  pointer = '/locale',
): { value?: string; issues: Issues } {
  const invalid = {
    issues: [
      fieldError(pointer, 'invalid_format', 'must be a BCP 47 language tag, such as en or en-GB'),
    ],
  };
  if (typeof value !== 'string')
    return { issues: [fieldError(pointer, 'invalid_type', 'must be a string')] };
  if (!LANGUAGE_SUBTAG.test(value)) return invalid;
  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(value);
  } catch {
    return invalid;
  }
  if (
    canonical === undefined ||
    canonical.length > MAX_LOCALE_LENGTH ||
    !LOCALE_SHAPE.test(canonical)
  )
    return invalid;
  return { value: canonical, issues: [] };
}

/** The avatar slot identifier (or null, which clears it), or the issues. */
export function checkAvatarSlot(
  value: unknown,
  pointer = '/avatar_slot',
): { value?: string | null; issues: Issues } {
  if (value === null) return { value: null, issues: [] };
  if (typeof value !== 'string')
    return { issues: [fieldError(pointer, 'invalid_type', 'must be a string or null')] };
  const slot = normaliseText(value);
  const length = [...slot].length;
  if (length < 1)
    return { issues: [fieldError(pointer, 'too_short', 'must be at least 1 character')] };
  if (length > MAX_AVATAR_LENGTH) {
    return {
      issues: [fieldError(pointer, 'too_long', `must be at most ${MAX_AVATAR_LENGTH} characters`)],
    };
  }
  if (hasControlChars(slot))
    return {
      issues: [fieldError(pointer, 'invalid_format', 'must not contain control characters')],
    };
  return { value: slot, issues: [] };
}

/** The e-mail address as stored; a validation AppError otherwise. */
export function validateEmail(value: unknown): string {
  const { value: email, issues } = checkEmail(value);
  throwIfAny(issues);
  return email ?? '';
}

/** The display name as stored; a validation AppError otherwise. */
export function validateDisplayName(value: unknown): string {
  const { value: name, issues } = checkDisplayName(value);
  throwIfAny(issues);
  return name ?? '';
}

/** The locale as stored; a validation AppError otherwise. */
export function validateLocale(value: unknown): string {
  const { value: locale, issues } = checkLocale(value);
  throwIfAny(issues);
  return locale ?? DEFAULT_LOCALE;
}

const PATCH_FIELDS: ReadonlySet<string> = new Set([
  'display_name',
  'locale',
  'avatar_slot',
  'telemetry_opt_in',
]);

/**
 * A profile patch with every field checked and normalised. Unknown fields, a patch with no field,
 * and every bad field are reported together in one validation AppError.
 */
export function validateProfilePatch(patch: unknown): ProfilePatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validationFailed(
      [fieldError('', 'invalid_type', 'must be an object')],
      'Some fields are not valid.',
    );
  }
  const input = patch as Record<string, unknown>;
  const issues: Issues = [];
  const out: ProfilePatch = {};
  const keys = Object.keys(input).filter((key) => input[key] !== undefined);
  if (keys.length === 0) issues.push(fieldError('', 'too_few', 'must change at least one field'));
  for (const key of keys) {
    if (!PATCH_FIELDS.has(key))
      issues.push(fieldError(`/${key}`, 'not_allowed', 'is not a profile field'));
  }
  if (input['display_name'] !== undefined) {
    const result = checkDisplayName(input['display_name']);
    issues.push(...result.issues);
    if (result.value !== undefined) out.display_name = result.value;
  }
  if (input['locale'] !== undefined) {
    const result = checkLocale(input['locale']);
    issues.push(...result.issues);
    if (result.value !== undefined) out.locale = result.value;
  }
  if (input['avatar_slot'] !== undefined) {
    const result = checkAvatarSlot(input['avatar_slot']);
    issues.push(...result.issues);
    if (result.value !== undefined) out.avatar_slot = result.value;
  }
  if (input['telemetry_opt_in'] !== undefined) {
    if (typeof input['telemetry_opt_in'] === 'boolean')
      out.telemetry_opt_in = input['telemetry_opt_in'];
    else issues.push(fieldError('/telemetry_opt_in', 'invalid_type', 'must be true or false'));
  }
  throwIfAny(issues);
  return out;
}

/**
 * A display name from what a login method offered: the hint when it is usable (control characters
 * dropped, cut to 40 code points), else the e-mail's local part (also cut to 40), else "User".
 */
export function defaultDisplayName(email: string, hint?: string): string {
  const usable = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    const cleaned = [...normaliseText(text)]
      .filter((ch) => !hasControlChars(ch))
      .join('')
      .trim();
    const cut = [...cleaned].slice(0, 40).join('').trim();
    return checkName('displayName', cut).ok ? cut : undefined;
  };
  return usable(hint) ?? usable(email.slice(0, email.lastIndexOf('@'))) ?? 'User';
}

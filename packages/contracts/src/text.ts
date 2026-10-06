/**
 * Text rules (CT-IDS): UTF-8, NFC-normalised at the API boundary, control characters
 * U+0000-U+001F rejected except `\n` and `\t`; name lengths, slugs and e-mail addresses.
 *
 * Owns: normalisation and the CT-IDS text checks. Lengths count Unicode code points after NFC.
 * Must not: trim, re-case (except e-mail) or otherwise change text beyond what CT-IDS says.
 */
import type { Result, ValidationIssue } from './validate.js';

/** CT-IDS length limits, in code points after NFC normalisation. */
export const TEXT_LIMITS = {
  displayName: { min: 1, max: 40 },
  workspaceName: { min: 1, max: 60 },
  sessionName: { min: 1, max: 80 },
} as const;

/** A kind of name with a CT-IDS length limit. */
export type NameKind = keyof typeof TEXT_LIMITS;

/** CT-IDS slug: `[a-z0-9-]{3,40}`. */
export const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

/** CT-IDS: e-mail addresses are lower-cased and at most 254 characters. */
export const MAX_EMAIL_LENGTH = 254;

/** Thrown by `assertNoControlChars`; carries the issue for a problem+json `errors[]` entry. */
export class TextError extends Error {
  override name = 'TextError';
  /** CT-ERR code for the request as a whole. */
  readonly code = 'validation_failed';

  constructor(readonly issue: ValidationIssue) {
    super(issue.detail);
  }
}

/** NFC-normalises text (CT-IDS: at the API boundary). */
export function normaliseText(s: string): string {
  return s.normalize('NFC');
}

/** Index of the first forbidden control character (U+0000-U+001F except \t and \n), or -1. */
function firstControlChar(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f && c !== 0x09 && c !== 0x0a) return i;
  }
  return -1;
}

/** True if `s` holds a control character CT-IDS rejects. */
export function hasControlChars(s: string): boolean {
  return firstControlChar(s) !== -1;
}

/** Throws TextError if `s` holds a control character CT-IDS rejects (`\n` and `\t` are fine). */
export function assertNoControlChars(s: string): void {
  const i = firstControlChar(s);
  if (i !== -1) {
    const hex = s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    throw new TextError({ pointer: '', code: 'invalid_format', detail: `control character U+${hex} is not allowed` });
  }
}

const issue = (code: ValidationIssue['code'], detail: string): Result<never> => ({
  ok: false,
  errors: [{ pointer: '', code, detail }],
});

/** Normalises and checks untrusted text: a string, no control characters. */
function cleanText(value: unknown): Result<string> {
  if (typeof value !== 'string') return issue('invalid_type', 'must be a string');
  const text = normaliseText(value);
  const i = firstControlChar(text);
  if (i !== -1) return issue('invalid_format', 'must not contain control characters');
  return { ok: true, value: text };
}

/** Checks a display, workspace or session name; returns it NFC-normalised. Never throws. */
export function checkName(kind: NameKind, value: unknown): Result<string> {
  const text = cleanText(value);
  if (!text.ok) return text;
  const length = [...text.value].length;
  const { min, max } = TEXT_LIMITS[kind];
  if (length < min) return issue('too_short', `must be at least ${min} character${min === 1 ? '' : 's'}`);
  if (length > max) return issue('too_long', `must be at most ${max} characters`);
  return text;
}

/** Checks a slug (`[a-z0-9-]{3,40}`). Never throws. */
export function checkSlug(value: unknown): Result<string> {
  if (typeof value !== 'string') return issue('invalid_type', 'must be a string');
  return SLUG_PATTERN.test(value)
    ? { ok: true, value }
    : issue('invalid_format', 'must be 3-40 characters of a-z, 0-9 and -');
}

/**
 * Normalises an e-mail address per CT-IDS (NFC, lower-cased, at most 254 characters). Format
 * checks belong to the schema (`format: email`); this only applies the CT-IDS text rules.
 */
export function normaliseEmail(value: unknown): Result<string> {
  const text = cleanText(value);
  if (!text.ok) return text;
  const email = text.value.toLowerCase();
  if (email.length === 0) return issue('too_short', 'must not be empty');
  if ([...email].length > MAX_EMAIL_LENGTH) return issue('too_long', `must be at most ${MAX_EMAIL_LENGTH} characters`);
  return { ok: true, value: email };
}

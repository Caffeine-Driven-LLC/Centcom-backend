/**
 * Project request bodies (B035, CT-API-WORKSPACES `ProjectCreate`, `ProjectUpdate`):
 *
 * - `name`: 1-60 code points after NFC, no control characters (CT-IDS text rules; the limit is
 *   CT-API-WORKSPACES' `name (1-60)`);
 * - `repo`: an opaque reference the client chooses, 1-128 code points (CT-API-WORKSPACES:
 *   `opaque ≤ 128 chars`, a hash of the normalised remote rather than the URL). Anything that looks
 *   like a local path, a URL carrying credentials, or a token is refused, so none is ever stored
 *   (privacy budget, CT-WS-SESSION-EVENTS); on update, null clears it.
 *
 * Unknown fields are ignored (CT-VER) and never stored. A bad value is a 422 `validation_failed`
 * whose `errors[]` point at the fields; the rejected values are never echoed.
 *
 * Owns: parsing the bodies and the `repo` rules. Must not: echo or log a rejected value.
 */
import {
  checkName,
  hasControlChars,
  normaliseText,
  type ValidationIssue,
} from '@centcom/contracts';
import { redact, validationFailed, type FieldError } from '@centcom/core';

/** The detail of a 422 on a project body (GUIDELINES §3.4: one message table). */
export const INVALID_PROJECT_BODY_DETAIL = 'Some fields are not valid.';
/** The longest `repo`, in code points after NFC (CT-API-WORKSPACES). */
export const MAX_REPO_REF_LENGTH = 128;

/** A checked `ProjectCreate`. */
export interface ProjectInput {
  name: string;
  /** The opaque repository reference, or null when none was given. */
  repoRef: string | null;
}

/** A checked `ProjectUpdate`: only the fields present. */
export interface ProjectPatch {
  name?: string;
  /** Null clears the reference. */
  repoRef?: string | null;
  /** The names of the fields given (for the audit event), in body order: `name`, `repo`. */
  fields: string[];
}

/** A local path: POSIX absolute or home-relative, relative, Windows drive, UNC or `file:`. */
const LOCAL_PATH = /^(?:[/~]|\.{1,2}(?:[/\\]|$)|[A-Za-z]:[\\/]|\\\\|file:)/i;
/** A URL with a user part (`https://user:pw@host`, `https://<token>@host`). */
const URL_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;
/** A query parameter that carries a credential. */
const SECRET_PARAM =
  /[?&#](?:access_token|auth|key|password|private_token|secret|sig|signature|token)=/i;
/**
 * Well-known credential shapes: GitHub, GitLab, Slack, npm, OpenAI-style, Stripe, AWS and Google
 * keys, and PEM blocks. Centcom API keys, JWTs and bearer credentials are caught by the log
 * redactor (B005), which is asked too.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const issue = (code: ValidationIssue['code'], detail: string): ValidationIssue[] => [
  { pointer: '', code, detail },
];

/**
 * Checks a `repo` value; returns it NFC-normalised, or the issues (pointers below the field).
 * The details describe the rule broken, never the value.
 */
export function checkRepoRef(value: unknown): { value: string } | { issues: ValidationIssue[] } {
  if (typeof value !== 'string') return { issues: issue('invalid_type', 'must be a string') };
  const text = normaliseText(value);
  const length = [...text].length;
  if (length === 0) return { issues: issue('too_short', 'must not be empty') };
  if (length > MAX_REPO_REF_LENGTH) {
    return { issues: issue('too_long', `must be at most ${MAX_REPO_REF_LENGTH} characters`) };
  }
  if (hasControlChars(text) || /\s/.test(text)) {
    return { issues: issue('invalid_format', 'must not contain spaces or control characters') };
  }
  if (LOCAL_PATH.test(text) || text.includes('\\')) {
    return { issues: issue('invalid_format', 'must be a repository reference, not a local path') };
  }
  if (
    URL_WITH_USERINFO.test(text) ||
    SECRET_PARAM.test(text) ||
    TOKEN_SHAPES.some((shape) => shape.test(text)) ||
    redact(text) !== text
  ) {
    return { issues: issue('invalid_format', 'must not contain credentials or tokens') };
  }
  return { value: text };
}

const at = (pointer: string, issues: readonly ValidationIssue[]): FieldError[] =>
  issues.map((i) => ({ pointer: `${pointer}${i.pointer}`, code: i.code, detail: i.detail }));

/** The body as an object, or a 422. */
function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  return body as Record<string, unknown>;
}

/** The name's issues, or its checked value (same CT-IDS rules and 1-60 limit as a workspace name). */
function checkProjectName(value: unknown): { value: string } | { issues: ValidationIssue[] } {
  const name = checkName('workspaceName', value);
  return name.ok ? { value: name.value } : { issues: name.errors };
}

/** Checks a `ProjectCreate` body: `name` required, `repo` optional; other fields ignored. */
export function parseProjectCreate(body: unknown): ProjectInput {
  const input = objectBody(body);
  const issues: FieldError[] = [];
  let name: string | undefined;
  if (input['name'] === undefined) {
    issues.push({ pointer: '/name', code: 'required', detail: 'is required' });
  } else {
    const checked = checkProjectName(input['name']);
    if ('issues' in checked) issues.push(...at('/name', checked.issues));
    else name = checked.value;
  }
  let repoRef: string | null = null;
  if (input['repo'] !== undefined) {
    const checked = checkRepoRef(input['repo']);
    if ('issues' in checked) issues.push(...at('/repo', checked.issues));
    else repoRef = checked.value;
  }
  if (issues.length > 0 || name === undefined) {
    throw validationFailed(issues, INVALID_PROJECT_BODY_DETAIL);
  }
  return { name, repoRef };
}

/**
 * Checks a `ProjectUpdate` body: `name` and `repo` (null clears it); anything else is ignored. A
 * body naming neither is a 422 (the schema's `minProperties: 1`).
 */
export function parseProjectUpdate(body: unknown): ProjectPatch {
  const input = objectBody(body);
  const issues: FieldError[] = [];
  const patch: ProjectPatch = { fields: [] };
  if (input['name'] !== undefined) {
    const checked = checkProjectName(input['name']);
    if ('issues' in checked) {
      issues.push(...at('/name', checked.issues));
    } else {
      patch.name = checked.value;
      patch.fields.push('name');
    }
  }
  if (input['repo'] !== undefined) {
    const raw = input['repo'];
    const checked = raw === null ? { value: null } : checkRepoRef(raw);
    if ('issues' in checked) {
      issues.push(...at('/repo', checked.issues));
    } else {
      patch.repoRef = checked.value;
      patch.fields.push('repo');
    }
  }
  if (issues.length > 0) throw validationFailed(issues, INVALID_PROJECT_BODY_DETAIL);
  if (patch.fields.length === 0) {
    throw validationFailed(
      [{ pointer: '', code: 'too_few', detail: 'must name at least one field to change' }],
      INVALID_PROJECT_BODY_DETAIL,
    );
  }
  return patch;
}

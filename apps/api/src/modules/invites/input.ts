/**
 * Invite request bodies (B029, CT-API-WORKSPACES `InviteCreate`, `KeyBundle`):
 *
 * - an invite names an optional e-mail address (CT-IDS: NFC, lower case; none makes a link
 *   invite), a role (`admin`, `member`, `billing` or `guest`; `member` by default) and whether the
 *   invitee gets the session history (`share_history`, true by default, CT-CRYPTO §4);
 * - a key bundle is base64url of at least 48 bytes (a sealed box's overhead) and at most 16 KiB of
 *   text (413 beyond).
 *
 * Unknown fields are ignored (CT-VER). Owns: parsing. Must not: echo a rejected value.
 */
import { AppError, validationFailed, type FieldError } from '@centcom/core';
import type { InviteRole } from '@centcom/db';
import { checkEmail } from '../users/index.js';

/** The detail of a 422 on an invite body (GUIDELINES §3.4). */
export const INVALID_INVITE_BODY_DETAIL = 'Some fields are not valid.';
/** Roles an invite may give. */
export const INVITE_ROLES: readonly InviteRole[] = ['admin', 'member', 'billing', 'guest'];
/** The longest key bundle, in base64url characters (16 KiB). */
export const MAX_KEY_BUNDLE_CHARS = 16 * 1024;
/** The shortest key bundle, in bytes: crypto_box_seal adds 48. */
export const MIN_KEY_BUNDLE_BYTES = 48;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A checked `InviteCreate`. */
export interface InviteInput {
  email?: string;
  role: InviteRole;
  shareHistory: boolean;
}

const objectBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  return body as Record<string, unknown>;
};

/** Checks an `InviteCreate` body. */
export function parseInviteCreate(body: unknown): InviteInput {
  const input = objectBody(body);
  const issues: FieldError[] = [];
  const out: InviteInput = { role: 'member', shareHistory: true };
  if (input['email'] !== undefined) {
    const email = checkEmail(input['email'], '/email');
    if (email.value === undefined) issues.push(...email.issues);
    else out.email = email.value;
  }
  const role = input['role'];
  if (role !== undefined) {
    if (typeof role === 'string' && (INVITE_ROLES as readonly string[]).includes(role)) {
      out.role = role as InviteRole;
    } else {
      issues.push({
        pointer: '/role',
        code: 'invalid_value',
        detail: `must be one of: ${INVITE_ROLES.join(', ')}`,
      });
    }
  }
  const share = input['share_history'];
  if (share !== undefined) {
    if (typeof share === 'boolean') out.shareHistory = share;
    else
      issues.push({
        pointer: '/share_history',
        code: 'invalid_type',
        detail: 'must be true or false',
      });
  }
  if (issues.length > 0) throw validationFailed(issues, INVALID_INVITE_BODY_DETAIL);
  return out;
}

/** The bytes of a `KeyBundle` body: 413 over 16 KiB, 422 when not base64url or under 48 bytes. */
export function parseKeyBundle(body: unknown): Buffer {
  const bundle = objectBody(body)['bundle'];
  if (typeof bundle === 'string' && bundle.length > MAX_KEY_BUNDLE_CHARS) {
    throw new AppError('payload_too_large', {
      detail: `A key bundle is at most ${MAX_KEY_BUNDLE_CHARS} base64url characters.`,
    });
  }
  const invalid = (detail: string): never => {
    throw validationFailed(
      [{ pointer: '/bundle', code: 'invalid_format', detail }],
      INVALID_INVITE_BODY_DETAIL,
    );
  };
  if (typeof bundle !== 'string' || !BASE64URL.test(bundle)) return invalid('must be base64url');
  const bytes = Buffer.from(bundle, 'base64url');
  // Round-tripping catches lengths that do not decode exactly (a stray trailing character).
  if (bytes.toString('base64url') !== bundle) return invalid('must be base64url');
  if (bytes.length < MIN_KEY_BUNDLE_BYTES) {
    return invalid(`must hold at least ${MIN_KEY_BUNDLE_BYTES} bytes`);
  }
  return bytes;
}

/**
 * Invite tokens (B029): 160 bits from the platform CSPRNG, base64url (27 characters), the only
 * secret in an invite link. The server keeps only their sha256, and finds an invite by that hash
 * (a unique index lookup: no comparison of secrets in code).
 *
 * Owns: making and hashing tokens. Must not: log, store or return a token anywhere but the create
 * response and the invite e-mail.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Token bytes: 160 bits. */
export const INVITE_TOKEN_BYTES = 20;
/** What a token looks like: 27 base64url characters. */
export const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{27}$/;

/** True for a string shaped like a token (anything else cannot match one, so it is not looked up). */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === 'string' && INVITE_TOKEN_SHAPE.test(value);

/** sha256 of a token: what the database holds. */
export const hashInviteToken = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

/** A new token and its hash. */
export function newInviteToken(): { token: string; hash: Buffer } {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

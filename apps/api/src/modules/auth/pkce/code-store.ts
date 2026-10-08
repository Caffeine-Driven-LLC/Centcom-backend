/**
 * Authorization codes (B018, CT-AUTH "Authorization code"): 256-bit random codes kept in Redis
 * (B009) under their SHA-256 only, with what they are bound to (client, redirect URI, S256
 * challenge, user, scope). A code lives 60 seconds and is used once: the first `claim` wins
 * atomically (`setIfAbsent`) and deletes it; every later claim is a replay.
 *
 * A replay must revoke the tokens the first exchange issued (RFC 6749 §4.1.2). So once tokens are
 * out, `recordIssued` keeps, for 15 minutes, the access token's `jti` and `exp` and the refresh
 * token sealed with AES-256-GCM under a key derived from the code itself: only a caller holding
 * the code (the replayer) can open it, and Redis never holds a usable token. Two exchanges racing
 * each see the other: the loser flags the replay before it reads the record, the winner writes the
 * record before it reads the flag.
 *
 * Owns: the code records and the replay record. Must not: store a code or a token in clear, or let
 * a code be claimed twice.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { isId } from '@centcom/contracts';
import { isAppError, unavailable, type KeyValue } from '@centcom/core';
import type { ClientId } from '@centcom/db';
import { CLIENT_IDS } from '../tokens/service.js';

/** How long a code is valid (CT-AUTH: 60 s). */
export const CODE_TTL_MS = 60_000;
/** How long a spent code is remembered, to revoke what it issued when it is replayed. */
export const CODE_REPLAY_WINDOW_MS = 15 * 60_000;
/** A code: 32 random bytes, base64url. */
export const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What a code is bound to. */
export interface CodeGrant {
  clientId: ClientId;
  redirectUri: string;
  /** The S256 `code_challenge`. */
  codeChallenge: string;
  userId: string;
  /** Space-separated scopes. */
  scope: string;
}

/** What an exchange issued, to revoke on a replay. */
export interface IssuedTokens {
  userId: string;
  /** The access token's `jti` and `exp` (seconds). */
  jti: string;
  exp: number;
  /** Absent when it could not be opened (it is never stored in clear). */
  refreshToken?: string;
}

/** The outcome of `claim`. */
export type CodeClaim =
  | { kind: 'claimed'; grant: CodeGrant }
  /** Never issued, expired, or malformed. */
  | { kind: 'unknown' }
  /** Used before; `issued` is what that exchange issued, if it got that far. */
  | { kind: 'replayed'; issued: IssuedTokens | null };

/** Runs a Redis step; an outage that is not already an AppError becomes a 503 without its details. */
export async function redisStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAppError(err)) throw err;
    throw unavailable(undefined, undefined, { cause: new Error('redis unavailable') });
  }
}

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');
const codeKey = (hash: string): string => `auth:code:${hash}`;
const usedKey = (hash: string): string => `auth:code-used:${hash}`;
const replayKey = (hash: string): string => `auth:code-replayed:${hash}`;
/** The used record before tokens are out. */
const CLAIMED = '{}';

const SEAL_INFO = 'centcom-pkce-replay-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const sealKey = (code: string): Buffer =>
  Buffer.from(hkdfSync('sha256', code, Buffer.alloc(0), SEAL_INFO, 32));

/** `plaintext` sealed under a key derived from `code`: iv, ciphertext and tag, base64url. */
export function sealWithCode(code: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealKey(code), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** The plaintext of `sealed`, or undefined when `code` is not the one it was sealed with. */
export function openWithCode(code: string, sealed: string): string | undefined {
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(code), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A stored code record, or undefined when it is not one. */
function readCode(raw: string): { grant: CodeGrant; expiresAt: number } | undefined {
  const value = parseJson(raw);
  if (!isRecord(value)) return undefined;
  const { cid, ru, cc, usr, scp, exp } = value;
  if (
    !(CLIENT_IDS as readonly unknown[]).includes(cid) ||
    typeof ru !== 'string' ||
    typeof cc !== 'string' ||
    !isId('usr', usr) ||
    typeof scp !== 'string' ||
    typeof exp !== 'number'
  ) {
    return undefined;
  }
  return {
    grant: {
      clientId: cid as ClientId,
      redirectUri: ru,
      codeChallenge: cc,
      userId: usr,
      scope: scp,
    },
    expiresAt: exp,
  };
}

/** A used record with tokens, or null (claimed only, or not readable). */
function readIssued(raw: string | null, code: string): IssuedTokens | null {
  const value = raw === null ? undefined : parseJson(raw);
  if (!isRecord(value)) return null;
  const { usr, jti, exp, rt } = value;
  if (!isId('usr', usr) || typeof jti !== 'string' || typeof exp !== 'number') return null;
  const refreshToken = typeof rt === 'string' ? openWithCode(code, rt) : undefined;
  return { userId: usr, jti, exp, ...(refreshToken === undefined ? {} : { refreshToken }) };
}

/** Authorization codes on a KeyValue store. */
export class AuthorizationCodeStore {
  constructor(private readonly deps: { kv: KeyValue }) {}

  /** A new code for `grant`, valid until `nowMs` + 60 s. */
  async issue(grant: CodeGrant, nowMs: number): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const record = JSON.stringify({
      cid: grant.clientId,
      ru: grant.redirectUri,
      cc: grant.codeChallenge,
      usr: grant.userId,
      scp: grant.scope,
      exp: nowMs + CODE_TTL_MS,
    });
    await redisStep(() =>
      this.deps.kv.set(codeKey(hashCode(code)), record, { ttlMs: CODE_TTL_MS }),
    );
    return code;
  }

  /**
   * Uses `code`: `claimed` with its grant for the first caller while it is valid at `nowMs`,
   * `replayed` for a code used before, `unknown` otherwise. A claimed code is gone, whatever the
   * caller does next.
   */
  async claim(code: string, nowMs: number): Promise<CodeClaim> {
    if (!CODE_PATTERN.test(code)) return { kind: 'unknown' };
    const hash = hashCode(code);
    const { kv } = this.deps;
    const raw = await redisStep(() => kv.get(codeKey(hash)));
    if (raw === null) {
      const used = await redisStep(() => kv.get(usedKey(hash)));
      return used === null ? { kind: 'unknown' } : this.replayed(code, hash);
    }
    const won = await redisStep(() =>
      kv.setIfAbsent(usedKey(hash), CLAIMED, CODE_REPLAY_WINDOW_MS),
    );
    if (!won) return this.replayed(code, hash);
    await redisStep(() => kv.del(codeKey(hash)));
    const record = readCode(raw);
    if (record === undefined || record.expiresAt <= nowMs) return { kind: 'unknown' };
    return { kind: 'claimed', grant: record.grant };
  }

  /**
   * Remembers what the exchange of `code` issued. True when the code was replayed meanwhile: the
   * caller must then revoke these tokens itself.
   */
  async recordIssued(code: string, issued: IssuedTokens): Promise<boolean> {
    const hash = hashCode(code);
    const { kv } = this.deps;
    const record = JSON.stringify({
      usr: issued.userId,
      jti: issued.jti,
      exp: issued.exp,
      ...(issued.refreshToken === undefined ? {} : { rt: sealWithCode(code, issued.refreshToken) }),
    });
    await redisStep(() => kv.set(usedKey(hash), record, { ttlMs: CODE_REPLAY_WINDOW_MS }));
    return (await redisStep(() => kv.get(replayKey(hash)))) !== null;
  }

  private async replayed(code: string, hash: string): Promise<CodeClaim> {
    const { kv } = this.deps;
    await redisStep(() => kv.set(replayKey(hash), '1', { ttlMs: CODE_REPLAY_WINDOW_MS }));
    return {
      kind: 'replayed',
      issued: readIssued(await redisStep(() => kv.get(usedKey(hash))), code),
    };
  }
}

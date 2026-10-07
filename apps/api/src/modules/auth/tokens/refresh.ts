/**
 * Refresh tokens (B017, CT-AUTH): opaque 256-bit random strings, stored only as their SHA-256 in
 * `refresh_tokens`. Every use rotates the token in one transaction that locks its row: the
 * presented token is marked used and a new one issued in the same family, valid 30 days (sliding)
 * but never past the family's 180-day absolute expiry. Presenting a spent token again is reuse:
 * the whole family is revoked (committed) and the caller gets `refresh_reuse_detected`.
 *
 * Owns: storing, rotating and revoking refresh tokens. Must not: store or log a token, tell an
 * unknown token from a malformed, expired or revoked one (all are `invalid_grant`, one body), or
 * issue a token for a family that was revoked.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '@centcom/core';
import { withTransaction, type ClientId, type TokenDatabase } from '@centcom/db';
import type { Kysely, Selectable } from 'kysely';
import type { RefreshTokensTable } from '@centcom/db';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Random bytes in a refresh token. */
export const REFRESH_TOKEN_BYTES = 32;
/** A refresh token is valid this long after the rotation that issued it... */
export const REFRESH_SLIDING_MS = 30 * DAY_MS;
/** ...and never longer than this after its family's first token. */
export const REFRESH_ABSOLUTE_MS = 180 * DAY_MS;
/** What a refresh token looks like: 32 bytes, base64url without padding. */
export const REFRESH_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 of a refresh token, lower-case hex: the only form stored. */
export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** A new refresh token and its hash. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** What a refresh token grants: carried unchanged from token to token in a family. */
export interface RefreshGrant {
  userId: string;
  deviceId: string | null;
  clientId: ClientId;
  /** Space-separated scopes. */
  scope: string;
  workspaceId: string | null;
}

/** Every refresh failure but reuse: one code, one detail. */
export const invalidRefreshToken = (): AppError =>
  new AppError('invalid_grant', { detail: 'The refresh token is not valid.' });

/** A spent token was presented again; its family is revoked. */
export const refreshReuseDetected = (): AppError =>
  new AppError('refresh_reuse_detected', {
    detail: 'The refresh token was already used; every token of its sign-in has been revoked.',
  });

type RefreshRow = Selectable<RefreshTokensTable>;

/** What to do with a presented token's row. */
export type RotationDecision = 'rotate' | 'reuse' | 'invalid';

/**
 * Decides a rotation (pure): unknown or revoked is invalid; spent is reuse (whatever else is
 * wrong with the request); another client, a revoked device or a passed expiry is invalid.
 */
export function decideRotation(
  row:
    | Pick<
        RefreshRow,
        'revoked_at' | 'used_at' | 'client_id' | 'expires_at' | 'absolute_expires_at'
      >
    | undefined,
  ctx: { nowMs: number; clientId: string; deviceRevoked: boolean },
): RotationDecision {
  if (row === undefined || row.revoked_at !== null) return 'invalid';
  if (row.used_at !== null) return 'reuse';
  if (row.client_id !== ctx.clientId || ctx.deviceRevoked) return 'invalid';
  if (ctx.nowMs >= row.expires_at.getTime() || ctx.nowMs >= row.absolute_expires_at.getTime())
    return 'invalid';
  return 'rotate';
}

const grantOf = (row: RefreshRow): RefreshGrant => ({
  userId: row.user_id,
  deviceId: row.device_id,
  clientId: row.client_id,
  scope: row.scope,
  workspaceId: row.workspace_id,
});

/** Where refresh tokens live: `RefreshTokenStore` (Postgres) in the API, a fake in tests. */
export interface RefreshStore {
  /** The first token of a new family. */
  issue(grant: RefreshGrant): Promise<string>;
  /**
   * Spends `token` and returns its successor and grant. 400 `invalid_grant` for anything unusable;
   * 401 `refresh_reuse_detected`, after revoking the family, for a spent token.
   */
  rotate(
    token: string,
    clientId: string,
    onReuse?: (familyId: string) => void,
  ): Promise<{ token: string; grant: RefreshGrant; familyId: string }>;
  revokeFamily(familyId: string): Promise<void>;
  /** Revokes the family of `token` if it is `userId`'s; false when there is no such token. */
  revokeByToken(token: string, userId: string): Promise<boolean>;
  /** Marks the device revoked and revokes its refresh tokens. */
  revokeDevice(deviceId: string): Promise<void>;
  /** The device's owner and state; undefined for an unknown device. */
  device(deviceId: string): Promise<{ userId: string; revoked: boolean } | undefined>;
}

/** Dependencies of the store. */
export interface RefreshStoreDeps {
  db: Kysely<TokenDatabase>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

type Outcome =
  | { kind: 'rotated'; token: string; grant: RefreshGrant; familyId: string }
  | { kind: 'reuse'; familyId: string }
  | { kind: 'invalid' };

/** Refresh tokens in Postgres. */
export class RefreshTokenStore implements RefreshStore {
  constructor(private readonly deps: RefreshStoreDeps) {}

  /** The first token of a new family. */
  async issue(grant: RefreshGrant): Promise<string> {
    const nowMs = this.deps.now();
    const { token, hash } = newRefreshToken();
    await this.deps.db
      .insertInto('refresh_tokens')
      .values({
        token_hash: hash,
        family_id: randomBytes(16).toString('hex'),
        parent_hash: null,
        user_id: grant.userId,
        device_id: grant.deviceId,
        client_id: grant.clientId,
        scope: grant.scope,
        workspace_id: grant.workspaceId,
        expires_at: new Date(nowMs + REFRESH_SLIDING_MS),
        absolute_expires_at: new Date(nowMs + REFRESH_ABSOLUTE_MS),
      })
      .execute();
    return token;
  }

  /**
   * Spends `token` and returns its successor with the grant it carries. Throws the 400
   * `invalid_grant` for anything unusable and the 401 `refresh_reuse_detected` (after revoking the
   * family) for a spent token. `onReuse` hears of the revoked family, for logging.
   */
  async rotate(
    token: string,
    clientId: string,
    onReuse?: (familyId: string) => void,
  ): Promise<{ token: string; grant: RefreshGrant; familyId: string }> {
    if (!REFRESH_TOKEN_SHAPE.test(token)) throw invalidRefreshToken();
    const hash = hashRefreshToken(token);
    const nowMs = this.deps.now();
    const outcome = await withTransaction(this.deps.db, async (trx): Promise<Outcome> => {
      // The row lock makes concurrent uses of one token queue up: the first rotates, the rest find it spent.
      const row = await trx
        .selectFrom('refresh_tokens')
        .selectAll()
        .where('token_hash', '=', hash)
        .forUpdate()
        .executeTakeFirst();
      let deviceRevoked = false;
      if (row !== undefined && row.device_id !== null) {
        const device = await trx
          .selectFrom('devices')
          .select('revoked_at')
          .where('id', '=', row.device_id)
          .executeTakeFirst();
        deviceRevoked = device === undefined || device.revoked_at !== null;
      }
      const decision = decideRotation(row, { nowMs, clientId, deviceRevoked });
      if (row === undefined || decision === 'invalid') return { kind: 'invalid' };
      if (decision === 'reuse') {
        await revokeFamilyWith(trx, row.family_id, nowMs);
        return { kind: 'reuse', familyId: row.family_id };
      }
      const next = newRefreshToken();
      await trx
        .updateTable('refresh_tokens')
        .set({ used_at: new Date(nowMs) })
        .where('token_hash', '=', hash)
        .execute();
      await trx
        .insertInto('refresh_tokens')
        .values({
          token_hash: next.hash,
          family_id: row.family_id,
          parent_hash: hash,
          user_id: row.user_id,
          device_id: row.device_id,
          client_id: row.client_id,
          scope: row.scope,
          workspace_id: row.workspace_id,
          expires_at: new Date(
            Math.min(nowMs + REFRESH_SLIDING_MS, row.absolute_expires_at.getTime()),
          ),
          absolute_expires_at: row.absolute_expires_at,
        })
        .execute();
      return { kind: 'rotated', token: next.token, grant: grantOf(row), familyId: row.family_id };
    });
    // Thrown only now: the family's revocation had to commit first.
    if (outcome.kind === 'reuse') {
      onReuse?.(outcome.familyId);
      throw refreshReuseDetected();
    }
    if (outcome.kind === 'invalid') throw invalidRefreshToken();
    return { token: outcome.token, grant: outcome.grant, familyId: outcome.familyId };
  }

  /** Revokes every token of a family. */
  async revokeFamily(familyId: string): Promise<void> {
    await revokeFamilyWith(this.deps.db, familyId, this.deps.now());
  }

  /** Revokes the family of `token` if it belongs to `userId`; false when there is no such token (RFC 7009: not an error). */
  async revokeByToken(token: string, userId: string): Promise<boolean> {
    if (!REFRESH_TOKEN_SHAPE.test(token)) return false;
    const row = await this.deps.db
      .selectFrom('refresh_tokens')
      .select('family_id')
      .where('token_hash', '=', hashRefreshToken(token))
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return false;
    await this.revokeFamily(row.family_id);
    return true;
  }

  /** Marks the device revoked and revokes every refresh token bound to it, in one transaction. */
  async revokeDevice(deviceId: string): Promise<void> {
    const at = new Date(this.deps.now());
    await withTransaction(this.deps.db, async (trx) => {
      await trx
        .updateTable('devices')
        .set({ revoked_at: at })
        .where('id', '=', deviceId)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: at })
        .where('device_id', '=', deviceId)
        .where('revoked_at', 'is', null)
        .execute();
    });
  }

  /** The device's owner and whether it is revoked; undefined for an unknown device. */
  async device(deviceId: string): Promise<{ userId: string; revoked: boolean } | undefined> {
    const row = await this.deps.db
      .selectFrom('devices')
      .select(['user_id', 'revoked_at'])
      .where('id', '=', deviceId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { userId: row.user_id, revoked: row.revoked_at !== null };
  }
}

async function revokeFamilyWith(
  db: Kysely<TokenDatabase>,
  familyId: string,
  nowMs: number,
): Promise<void> {
  await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date(nowMs) })
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
    .execute();
}

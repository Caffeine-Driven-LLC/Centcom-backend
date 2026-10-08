/**
 * Access-token revocation (B017): flags in Redis (B009 KeyValue) that verification checks, so a
 * revoked token or device stops working at once rather than at its `exp`. `revoked:jti:<jti>`
 * lives as long as the token could (at most 16 min); `revoked:dev:<id>` lives 16 min, which
 * covers every access token the device still holds (new ones cannot be issued: the refresh store
 * and device records are revoked in the database). `revoked:usr:<id>` (B087's staff revocation)
 * holds the time of the revocation, in epoch milliseconds, for 16 min: every access token of the
 * user issued (`iat`) at or before it is revoked.
 *
 * When Redis cannot be asked, tokens with the `admin` scope fail closed (503) and the rest fail
 * open: they stay valid for what is left of their 15 min, counted in
 * `auth_revocation_unavailable_total` and logged (ids only) at most once a minute.
 *
 * Owns: the revocation flags. Must not: log a token, or fail open for `admin`.
 */
import { unavailable, type KeyValue, type Logger, type Metrics } from '@centcom/core';
import type { AccessClaims } from './jwt.js';
import { CLOCK_SKEW_S } from './jwt.js';

/** How long a device's revocation flag lives: longer than any access token. */
export const REVOCATION_TTL_MS = 16 * 60 * 1000;
/** The scope whose tokens fail closed when revocation cannot be checked. */
export const ADMIN_SCOPE = 'admin';

const jtiKey = (jti: string): string => `revoked:jti:${jti}`;
const deviceKey = (deviceId: string): string => `revoked:dev:${deviceId}`;
const userKey = (userId: string): string => `revoked:usr:${userId}`;

/** What a revocation check found. */
export type RevocationState = 'live' | 'token_revoked' | 'device_revoked';

/** Dependencies of the revocation list. */
export interface RevocationDeps {
  kv: KeyValue;
  now: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Revocation flags for access tokens and devices. */
export class RevocationList {
  private lastWarnedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: RevocationDeps) {}

  /** Revokes the access token `jti` until its expiry (`expUnix`, seconds) plus the skew; at most 16 min. */
  async revokeJti(jti: string, expUnix: number): Promise<void> {
    const remaining = (expUnix + CLOCK_SKEW_S) * 1000 - this.deps.now();
    if (remaining <= 0) return; // already expired everywhere
    await this.deps.kv.set(jtiKey(jti), '1', {
      ttlMs: Math.min(REVOCATION_TTL_MS, Math.ceil(remaining)),
    });
  }

  /** Makes every access token of the device fail with `device_revoked`. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.deps.kv.set(deviceKey(deviceId), '1', { ttlMs: REVOCATION_TTL_MS });
  }

  /** Makes every access token of the user issued at or before `atMs` fail with `token_revoked`. */
  async revokeUser(userId: string, atMs: number): Promise<void> {
    await this.deps.kv.set(userKey(userId), String(atMs), { ttlMs: REVOCATION_TTL_MS });
  }

  /**
   * Whether the token behind `claims` was revoked (by jti, device, or its user's revocation when
   * `sub` and `iat` are given). Redis unavailable: a 503 for `admin` tokens, `live` for the rest
   * (fail open).
   */
  async check(
    claims: Pick<AccessClaims, 'jti' | 'dev' | 'scp'> & Partial<Pick<AccessClaims, 'sub' | 'iat'>>,
  ): Promise<RevocationState> {
    try {
      const [byJti, byDevice, byUser] = await Promise.all([
        this.deps.kv.get(jtiKey(claims.jti)),
        claims.dev === undefined ? Promise.resolve(null) : this.deps.kv.get(deviceKey(claims.dev)),
        claims.sub === undefined ? Promise.resolve(null) : this.deps.kv.get(userKey(claims.sub)),
      ]);
      if (byDevice !== null) return 'device_revoked';
      if (byUser !== null && claims.iat !== undefined && claims.iat * 1000 <= Number(byUser)) {
        return 'token_revoked';
      }
      return byJti === null ? 'live' : 'token_revoked';
    } catch (err) {
      const admin = claims.scp.split(' ').includes(ADMIN_SCOPE);
      this.deps.metrics
        ?.counter('auth_revocation_unavailable_total', { outcome: admin ? 'closed' : 'open' })
        .inc();
      const now = this.deps.now();
      if (now - this.lastWarnedAt >= 60_000) {
        this.lastWarnedAt = now;
        this.deps.logger?.warn(
          { jti: claims.jti, err },
          'auth.revocation_unavailable: revocation not checked; non-admin tokens accepted until they expire',
        );
      }
      if (admin) throw unavailable(undefined, 'Authentication is temporarily unavailable.');
      return 'live';
    }
  }
}

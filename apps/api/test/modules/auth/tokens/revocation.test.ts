/**
 * Revocation (B017 acceptance 6, card test revocation.test.ts): a revoked jti answers
 * `token_revoked`, a revoked device's tokens `device_revoked` within a second, revoking a family
 * ends its refresh tokens, flags expire after 16 min, and when Redis cannot be asked `admin` tokens
 * fail closed while the rest fail open, counted and logged without the token.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_SCOPE,
  REVOCATION_TTL_MS,
  RevocationList,
} from '../../../../src/modules/auth/tokens/index.js';
import { captureLogger, recordingMetrics } from '../../../helpers.js';
import { memoryTokens, memoryUser } from './helpers.js';

describe('revocation', () => {
  it('answers token_revoked for a revoked jti, until the token would have expired anyway', async () => {
    const { tokens, store, clock, redis } = memoryTokens();
    const user = memoryUser(store);
    const { access_token: token } = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const claims = await tokens.verifyAccessToken(token);
    await tokens.revokeAccessJti(claims.jti, claims.exp);
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'token_revoked',
      status: 401,
    });
    // The flag outlives the token by the skew, never more than 16 min.
    const ttl = await redis.kv.ttl(`revoked:jti:${claims.jti}`);
    expect(ttl).toBeGreaterThan(15 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(REVOCATION_TTL_MS);
    // An expired token needs no flag.
    await tokens.revokeAccessJti('already-gone', Math.floor(clock.now() / 1000) - 120);
    expect(await redis.kv.get('revoked:jti:already-gone')).toBeNull();
  });

  it('answers device_revoked for every token of a revoked device, within a second (acceptance 6)', async () => {
    const { tokens, store } = memoryTokens();
    const user = memoryUser(store);
    const issued = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    const other = await tokens.issueTokens({ ...memoryUser(store), scopes: ['profile'] });
    const started = performance.now();
    await tokens.revokeDevice(user.deviceId);
    await expect(tokens.verifyAccessToken(issued.access_token)).rejects.toMatchObject({
      code: 'device_revoked',
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect((await tokens.verifyAccessToken(other.access_token)).sub).toBe(other.user);
    // Its refresh tokens are revoked too, and no new tokens are issued for it.
    await expect(
      tokens.refresh({ refreshToken: issued.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    await expect(tokens.issueTokens({ ...user, scopes: ['profile'] })).rejects.toMatchObject({
      code: 'device_revoked',
    });
  });

  it('revokes a refresh family', async () => {
    const { tokens, store } = memoryTokens();
    const issued = await tokens.issueTokens({ ...memoryUser(store), scopes: ['profile'] });
    const rotated = await tokens.refresh({
      refreshToken: issued.refresh_token,
      clientId: 'centcom-cli',
    });
    const familyId = [...store.rows.values()][0]?.familyId ?? '';
    await tokens.revokeFamily(familyId);
    await expect(
      tokens.refresh({ refreshToken: rotated.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('expires device flags after 16 minutes', async () => {
    const { tokens, redis } = memoryTokens();
    await tokens.revokeDevice('dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W');
    expect(await redis.kv.ttl('revoked:dev:dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).toBe(
      REVOCATION_TTL_MS,
    );
  });

  it('fails closed for admin tokens and open for the rest when Redis is down (failure mode)', async () => {
    const { redis, clock } = memoryTokens();
    await redis.close(); // every call now rejects with a 503
    const captured = captureLogger();
    const recorded = recordingMetrics();
    const list = new RevocationList({
      kv: redis.kv,
      now: clock.now,
      logger: captured.logger,
      metrics: recorded.metrics,
    });
    const jti = 'jti-under-outage';
    expect(await list.check({ jti, scp: 'profile', dev: 'dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W' })).toBe(
      'live',
    );
    await expect(list.check({ jti, scp: `profile ${ADMIN_SCOPE}` })).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
    expect(recorded.count('auth_revocation_unavailable_total', { outcome: 'open' })).toBe(1);
    expect(recorded.count('auth_revocation_unavailable_total', { outcome: 'closed' })).toBe(1);
    // One warning a minute, with the token id only.
    const warnings = () =>
      captured
        .lines()
        .filter((line) => String(line['msg']).startsWith('auth.revocation_unavailable'));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({ jti, level: 'warn' });
    clock.advance(60_000);
    await list.check({ jti, scp: 'profile' });
    expect(warnings()).toHaveLength(2);
  });
});

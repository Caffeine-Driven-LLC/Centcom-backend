/**
 * Failing dependencies (B030 acceptance 5 and failure modes; tests
 * "seats.dependency-failure.test.ts"): an entitlements reader that fails makes the gate fail
 * closed with a retryable 503, before any lock or count; a lock wait past 5 s (`lock_timeout`,
 * 55P03), a cancelled statement or a lost connection is a 503 with `Retry-After`; any other
 * database error is passed on unchanged. Each refusal is counted by reason.
 */
import { isAppError, unavailable } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  createSeatGate,
  SEAT_LOCK_RETRY_AFTER_S,
  seatLimitsFrom,
} from '../../../src/modules/seats/index.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { newId } from '../users/helpers.js';
import { fixedSeats, fixtureEntitlements, scriptedTrx } from './helpers.js';

const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

describe('the entitlements reader fails', () => {
  it.each([
    ['throws an error', () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.3:5432'))],
    ['answers 503', () => Promise.reject(unavailable())],
  ])('when it %s: 503, no lock, no count, logged', async (_case, get) => {
    const { metrics, count } = recordingMetrics();
    const captured = captureLogger();
    const seats = fixedSeats(0);
    const gate = createSeatGate({
      seats,
      limits: seatLimitsFrom({ get }),
      metrics,
      logger: captured.logger,
    });
    const trx = scriptedTrx();
    const error = await gate.assertCanAdd(trx, newId('wsp')).catch((err: unknown) => err);
    expect(isAppError(error) && error.status).toBe(503);
    expect(isAppError(error) && error.code).toBe('service_unavailable');
    expect(JSON.stringify(error)).not.toContain('10.0.0.3');
    expect(trx.statements).toEqual([]);
    expect(seats.calls).toEqual([]);
    expect(count('seat_gate_rejections_total', { reason: 'entitlements_unavailable' })).toBe(1);
    expect(captured.lines().some((l) => l['msg'] === 'seats.entitlements_unavailable')).toBe(true);
  });
});

describe('the lock cannot be taken', () => {
  it.each([
    ['a lock wait past lock_timeout', pgError('55P03', 'canceling statement due to lock timeout')],
    ['a statement timeout', pgError('57014', 'canceling statement due to statement timeout')],
    ['a lost connection', pgError('ECONNRESET', 'read ECONNRESET')],
  ])('after %s: 503 with Retry-After, no count', async (_case, failure) => {
    const { metrics, count } = recordingMetrics();
    const seats = fixedSeats(0);
    const gate = createSeatGate({
      seats,
      limits: seatLimitsFrom(fixtureEntitlements('team')),
      metrics,
    });
    const trx = scriptedTrx((sql) => (sql.includes('pg_advisory_xact_lock') ? failure : undefined));
    const error = await gate.assertCanAdd(trx, newId('wsp')).catch((err: unknown) => err);
    expect(isAppError(error) && error.status).toBe(503);
    expect(isAppError(error) && error.retryAfterS).toBe(SEAT_LOCK_RETRY_AFTER_S);
    expect(seats.calls).toEqual([]);
    expect(count('seat_gate_rejections_total', { reason: 'lock_timeout' })).toBe(1);
  });

  it('passes any other database error on unchanged', async () => {
    const boom = pgError('42P01', 'relation does not exist');
    const gate = createSeatGate({
      seats: fixedSeats(0),
      limits: seatLimitsFrom(fixtureEntitlements('team')),
    });
    const trx = scriptedTrx((sql) => (sql.includes('pg_advisory_xact_lock') ? boom : undefined));
    await expect(gate.assertCanAdd(trx, newId('wsp'))).rejects.toBe(boom);
  });
});

/**
 * The status map (B070 acceptance 2): every Stripe subscription status maps to one of the
 * contract's (active, trialing, past_due, canceled, none) as the card's table says; an unknown
 * future status is `none` with a warning that never echoes an unprintable value.
 *
 * "Contract statuses" are CT-ENTITLEMENTS' (`status` in entitlements.schema.json, which has
 * `none`). CT-API-BILLING's `Subscription.status` has only the other four, so `none` never goes
 * out as a `Subscription`: GET subscription answers 404 `not_found` for it (the route test).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  mapStripeStatus,
  STRIPE_STATUS_MAP,
} from '../../../src/modules/billing/stripe/status-map.js';
import { captureLogger } from '../../helpers.js';
import { newId } from './helpers.js';

const CONTRACT = ['active', 'trialing', 'past_due', 'canceled', 'none'];

/** CT-ENTITLEMENTS' free fixture, to try each mapped status against the entitlements schema. */
const ENTITLEMENTS = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../../contracts/fixtures/entitlements/free.json'),
      'utf8',
    ),
  ) as { data: Record<string, unknown> }
).data;

describe('mapStripeStatus', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'trialing'],
    ['past_due', 'past_due'],
    ['unpaid', 'past_due'],
    ['canceled', 'canceled'],
    ['incomplete', 'none'],
    ['incomplete_expired', 'none'],
    ['paused', 'none'],
  ])('maps %s to %s without a warning', (stripe, contract) => {
    const captured = captureLogger();
    expect(mapStripeStatus(stripe, captured.logger)).toBe(contract);
    expect(captured.lines()).toEqual([]);
  });

  it('covers every Stripe status and returns contract statuses only', () => {
    expect(Object.keys(STRIPE_STATUS_MAP).sort()).toEqual(
      [
        'active',
        'canceled',
        'incomplete',
        'incomplete_expired',
        'past_due',
        'paused',
        'trialing',
        'unpaid',
      ].sort(),
    );
    for (const status of Object.values(STRIPE_STATUS_MAP)) expect(CONTRACT).toContain(status);
  });

  it.each([['suspended'], ['ACTIVE'], [''], ['constructor'], ['__proto__'], ['bad\nvalue']])(
    'maps the unknown status %j to none with a warning',
    (status) => {
      const captured = captureLogger();
      expect(mapStripeStatus(status, captured.logger)).toBe('none');
      const [line] = captured.lines();
      expect(line?.['msg']).toBe('billing.unknown_stripe_status');
      expect(line?.['level']).toBe('warn');
      if (status.includes('\n')) expect(line?.['stripe_status']).toBe('unprintable');
    },
  );
});

describe('mapStripeStatus against the contracts', () => {
  /** Everything the map can return: the documented statuses and the fallback for unknown ones. */
  const outputs = [...new Set([...Object.values(STRIPE_STATUS_MAP), mapStripeStatus('suspended')])];

  it('returns only CT-ENTITLEMENTS statuses, whose enum includes none', () => {
    expect([...outputs].sort()).toEqual([...CONTRACT].sort());
    for (const status of outputs) {
      expect(validate('entitlements', { ...ENTITLEMENTS, status }).ok, status).toBe(true);
    }
    expect(validate('entitlements', { ...ENTITLEMENTS, status: 'incomplete' }).ok).toBe(false);
  });

  it('lets none into no CT-API-BILLING Subscription, so the route answers 404 for it', () => {
    const subscription = (status: string) => ({
      id: newId('sub'),
      workspace: newId('wsp'),
      plan: 'team',
      status,
      seats: 5,
      current_period_end: '2026-11-01T00:00:00.000Z',
    });
    const accepted = outputs.filter((s) => validate('api/Subscription', subscription(s)).ok);
    expect(accepted.sort()).toEqual(['active', 'canceled', 'past_due', 'trialing']);
    expect(validate('api/Subscription', subscription('none')).ok).toBe(false);
  });
});

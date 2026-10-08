/**
 * The status map (B070 acceptance 2): every Stripe subscription status maps to one of the
 * contract's (active, trialing, past_due, canceled, none) as the card's table says; an unknown
 * future status is `none` with a warning that never echoes an unprintable value.
 */
import { describe, expect, it } from 'vitest';
import {
  mapStripeStatus,
  STRIPE_STATUS_MAP,
} from '../../../src/modules/billing/stripe/status-map.js';
import { captureLogger } from '../../helpers.js';

const CONTRACT = ['active', 'trialing', 'past_due', 'canceled', 'none'];

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

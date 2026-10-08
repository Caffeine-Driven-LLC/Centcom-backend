/**
 * The price catalogue and Stripe configuration (B070 acceptance 6, guardrail "pin the Stripe API
 * version"): (team, month, EUR) gives its configured price and every price maps back; in
 * production a missing combination is a ConfigError naming its key at startup, elsewhere it is
 * just not for sale; a value that is not a price id, or one price selling two things, is refused.
 * The Stripe keys: the API version is pinned by default and may be set explicitly; a secret key
 * is required in production and must look like one; errors never carry a value.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  INTERVALS,
  loadPriceCatalog,
  PAID_PLANS,
  priceKey,
} from '../../../src/modules/billing/stripe/price-catalog.js';
import {
  loadStripeConfig,
  STRIPE_API_VERSION_DEFAULT,
} from '../../../src/modules/billing/stripe/stripe-client.js';
import { catalogEnv, testSecretKey } from './helpers.js';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('no ConfigError');
}

describe('loadPriceCatalog', () => {
  it('looks up every combination and maps each price back', () => {
    const catalog = loadPriceCatalog(catalogEnv());
    expect(catalog.price('team', 'month', 'EUR')).toBe('price_teammonthEUR');
    for (const interval of INTERVALS) {
      for (const currency of CURRENCIES) {
        for (const plan of PAID_PLANS) {
          const id = catalog.price(plan, interval, currency) ?? '';
          expect(catalog.lookup(id)).toEqual({ kind: 'plan', plan, interval, currency });
        }
        const seat = catalog.seatPrice(interval, currency) ?? '';
        expect(catalog.lookup(seat)).toEqual({ kind: 'seat', interval, currency });
      }
    }
    expect(catalog.lookup('price_unknown')).toBeNull();
  });

  it('refuses to start in production with a combination missing, naming its key', () => {
    const missing = [priceKey('team', 'month', 'EUR'), priceKey('seat', 'year', 'USD')];
    const env = {
      ...Object.fromEntries(Object.entries(catalogEnv()).filter(([key]) => !missing.includes(key))),
      NODE_ENV: 'production',
    };
    const error = configError(() => loadPriceCatalog(env));
    expect(error.issues.map((i) => i.key).sort()).toEqual([
      'STRIPE_PRICE_SEAT_YEAR_USD',
      'STRIPE_PRICE_TEAM_MONTH_EUR',
    ]);
    expect(() => loadPriceCatalog({ ...catalogEnv(), NODE_ENV: 'production' })).not.toThrow();
  });

  it('leaves a missing combination unsold outside production', () => {
    const catalog = loadPriceCatalog({ STRIPE_PRICE_PRO_MONTH_USD: 'price_onlyOne' });
    expect(catalog.price('pro', 'month', 'USD')).toBe('price_onlyOne');
    expect(catalog.price('team', 'month', 'EUR')).toBeNull();
    expect(catalog.seatPrice('month', 'EUR')).toBeNull();
  });

  it('refuses values that are not price ids, and a price selling two things', () => {
    expect(
      configError(() => loadPriceCatalog({ STRIPE_PRICE_PRO_MONTH_USD: 'prod_123' })).issues[0]
        ?.key,
    ).toBe('STRIPE_PRICE_PRO_MONTH_USD');
    const twice = configError(() =>
      loadPriceCatalog({
        STRIPE_PRICE_PRO_MONTH_USD: 'price_same',
        STRIPE_PRICE_TEAM_MONTH_USD: 'price_same',
      }),
    );
    expect(twice.issues).toHaveLength(1);
    expect(twice.message).not.toContain('price_same');
  });
});

describe('loadStripeConfig', () => {
  it('pins the API version unless it is set explicitly', () => {
    const key = testSecretKey();
    expect(loadStripeConfig({ STRIPE_SECRET_KEY: key })?.apiVersion).toBe(
      STRIPE_API_VERSION_DEFAULT,
    );
    expect(
      loadStripeConfig({ STRIPE_SECRET_KEY: key, STRIPE_API_VERSION: '2026-01-28.clover' })
        ?.apiVersion,
    ).toBe('2026-01-28.clover');
    expect(
      configError(() => loadStripeConfig({ STRIPE_SECRET_KEY: key, STRIPE_API_VERSION: 'latest' }))
        .issues[0]?.key,
    ).toBe('STRIPE_API_VERSION');
  });

  it('is off without a key outside production, and refuses to start without one in production', () => {
    expect(loadStripeConfig({})).toBeNull();
    expect(configError(() => loadStripeConfig({ NODE_ENV: 'production' })).issues[0]?.key).toBe(
      'STRIPE_SECRET_KEY',
    );
  });

  it('refuses a key that is not a Stripe secret key, without echoing it', () => {
    const wrong = ['pk', 'test', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const error = configError(() => loadStripeConfig({ STRIPE_SECRET_KEY: wrong }));
    expect(error.issues[0]?.key).toBe('STRIPE_SECRET_KEY');
    expect(error.message).not.toContain(wrong);
    const badHook = configError(() =>
      loadStripeConfig({ STRIPE_SECRET_KEY: testSecretKey(), STRIPE_WEBHOOK_SECRET: 'nope' }),
    );
    expect(badHook.issues[0]?.key).toBe('STRIPE_WEBHOOK_SECRET');
  });
});

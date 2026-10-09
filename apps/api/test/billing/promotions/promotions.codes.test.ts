/**
 * Codes and trial eligibility (B079 test plan "unit: code normalisation and hashing; eligibility
 * truth table"; acceptance 6 and 7):
 *
 * - a code is NFC, trimmed and upper-cased before Stripe sees it, and only the sha256 of that is
 *   kept; empty, over-long, whitespace and control-character codes are not codes;
 * - `trialEligibility`: eligible for a fresh workspace and owner; `workspace_paid` while the
 *   workspace pays (active, past due) or after it did (canceled); `already_used` while it is in a
 *   trial, after it had one, or when the asking user or an owner had one elsewhere. The answer
 *   carries TRIAL_DAYS and TRIAL_PLAN;
 * - the configuration defaults to 14 days, team and 10 attempts, and refuses bad values;
 * - `recordTrial` keeps only trials Stripe reports `trialing`, once per workspace.
 */
import { createHash } from 'node:crypto';
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { codeHash, normaliseCode } from '../../../src/modules/billing/promotions/codes.js';
import { loadPromotionConfig } from '../../../src/modules/billing/promotions/config.js';
import { TrialService } from '../../../src/modules/billing/promotions/trials.js';
import type { SubscriptionRow } from '../../../src/modules/billing/subscriptions/repository.js';
import { memoryPromotions, newId, stripeId, stripeSub } from './helpers.js';

describe('coupon codes', () => {
  it('normalises: NFC, trimmed, upper case', () => {
    expect(normaliseCode('  spring-25 ')).toBe('SPRING-25');
    expect(normaliseCode('Spring25')).toBe('SPRING25');
    // "é" as e + combining acute becomes the one composed character.
    expect(normaliseCode('café')).toBe('CAFÉ');
    expect(normaliseCode('x'.repeat(64))).toBe('X'.repeat(64));
  });

  it('refuses what cannot be a code', () => {
    for (const raw of [
      '',
      '   ',
      'x'.repeat(65),
      'SPRING 25',
      'A\tB',
      'A\u0000B',
      'A\nB',
      7,
      null,
    ]) {
      expect(normaliseCode(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('hashes the normalised code with sha256, the same for every spelling', () => {
    const expected = createHash('sha256').update('SPRING25').digest('hex');
    expect(codeHash('SPRING25')).toBe(expected);
    expect(codeHash(normaliseCode(' spring25 ') ?? '')).toBe(expected);
    expect(codeHash('SPRING25')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the configuration', () => {
  it('defaults to 14 days of team and 10 attempts an hour', () => {
    expect(loadPromotionConfig({})).toEqual({
      trialDays: 14,
      trialPlan: 'team',
      redeemRatePerHour: 10,
    });
    expect(
      loadPromotionConfig({
        TRIAL_DAYS: '30',
        TRIAL_PLAN: 'pro',
        COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR: '5',
      }),
    ).toEqual({ trialDays: 30, trialPlan: 'pro', redeemRatePerHour: 5 });
  });

  it('refuses bad values, naming the key', () => {
    for (const env of [
      { TRIAL_DAYS: '0' },
      { TRIAL_DAYS: '91' },
      { TRIAL_PLAN: 'free' },
      { COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR: 'many' },
    ]) {
      expect(() => loadPromotionConfig(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});

/** A trial service over a workspace with `status` (or no subscription) and one owner. */
function trials(status: SubscriptionRow['status'] | null) {
  const ws = newId('wsp');
  const owner = newId('usr');
  const mirror = memoryPromotions({ [ws]: [owner] });
  const row = status === null ? null : ({ workspaceId: ws, status } as unknown as SubscriptionRow);
  const service = new TrialService({
    repository: mirror.repository,
    billing: {
      findSubscription: (id) => Promise.resolve(id === ws ? row : null),
      billingContact: () => Promise.resolve(null),
    },
    config: { trialDays: 14, trialPlan: 'team' },
  });
  return { ws, owner, mirror, service };
}

describe('trialEligibility', () => {
  it('follows the truth table', async () => {
    const cases: [SubscriptionRow['status'] | null, string | undefined][] = [
      [null, undefined],
      ['none', undefined],
      ['active', 'workspace_paid'],
      ['past_due', 'workspace_paid'],
      ['canceled', 'workspace_paid'],
      ['trialing', 'already_used'],
    ];
    for (const [status, reason] of cases) {
      const { ws, owner, service } = trials(status);
      const answer = await service.trialEligibility(ws, owner);
      expect(answer, String(status)).toEqual({
        eligible: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
        days: 14,
        plan: 'team',
      });
    }
  });

  it('refuses a second trial for the workspace, or for its owner or the asking user elsewhere', async () => {
    const { ws, owner, mirror, service } = trials(null);
    const otherWs = newId('wsp');
    const otherOwner = newId('usr');
    mirror.owners[otherWs] = [otherOwner];
    expect((await service.trialEligibility(otherWs, otherOwner)).eligible).toBe(true);

    // The owner had a trial in their first workspace.
    await mirror.repository.recordTrial({
      stripeSubscriptionId: stripeId('sub'),
      workspaceId: ws,
      ownerUserIds: [owner],
      trialEnd: null,
    });
    expect(await service.trialEligibility(ws, newId('usr'))).toMatchObject({
      eligible: false,
      reason: 'already_used',
    });
    // A new workspace of the same owner, asked by the owner or by another member.
    const third = newId('wsp');
    mirror.owners[third] = [owner];
    expect((await service.trialEligibility(third, owner)).reason).toBe('already_used');
    expect((await service.trialEligibility(third, newId('usr'))).reason).toBe('already_used');
    // The asking user had one, though not an owner here.
    expect((await service.trialEligibility(otherWs, owner)).reason).toBe('already_used');
    expect((await service.trialEligibility(otherWs, otherOwner)).eligible).toBe(true);
  });

  it('counts a trial for every owner the workspace had', async () => {
    const { ws, owner, mirror, service } = trials(null);
    const coOwner = newId('usr');
    mirror.owners[ws] = [owner, coOwner];
    await service.recordTrial(ws, stripeSub(stripeId('cus'), { status: 'trialing' }));
    const elsewhere = newId('wsp');
    mirror.owners[elsewhere] = [coOwner];
    expect((await service.trialEligibility(elsewhere, coOwner)).reason).toBe('already_used');
    expect((await service.trialEligibility(elsewhere, newId('usr'))).reason).toBe('already_used');
  });
});

describe('recordTrial', () => {
  it('keeps only trials Stripe reports trialing, once per workspace', async () => {
    const { ws, owner, mirror, service } = trials(null);
    const customer = stripeId('cus');
    expect(await service.recordTrial(ws, stripeSub(customer, { status: 'active' }))).toBe(false);
    expect(mirror.trials).toHaveLength(0);
    const trialing = stripeSub(customer, { status: 'trialing', trialEnd: 1_791_000_000 });
    expect(await service.recordTrial(ws, trialing)).toBe(true);
    expect(await service.recordTrial(ws, trialing)).toBe(false);
    expect(await service.recordTrial(ws, stripeSub(customer, { status: 'trialing' }))).toBe(false);
    expect(mirror.trials).toEqual([
      {
        stripeSubscriptionId: trialing.id,
        workspaceId: ws,
        ownerUserIds: [owner],
        trialEnd: new Date(1_791_000_000 * 1000),
      },
    ]);
  });
});

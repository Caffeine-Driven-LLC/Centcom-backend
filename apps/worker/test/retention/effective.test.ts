/**
 * Effective retention (B090 test plan "unit: effective retention resolution (plan, override, free =
 * 0) with fake clock"; acceptance 4 "The workspace-level retention override (settings) can only
 * shorten retention: an override of 30 days on a 7-day plan yields 7; an override of 3 days yields
 * 3"; guardrail "MUST apply the 7-day notice on downgrades; MUST NOT shorten retention
 * retroactively without it"):
 *
 * - the plan's days, shortened (never lengthened) by an override; the free plan's 0;
 * - a first sight takes the effective days as the baseline, without notice;
 * - a drop announces a shortening that keeps the old days for 7 days, then applies (from 4 minutes
 *   before its time, never 5); for history only once the notice and the email went out, 7 days
 *   after the later of the two; audit just waits; a rise back to the old days or more withdraws
 *   it and enforces the new days at once; a further drop restarts it; a partial rise keeps its
 *   time; a rise without a shortening applies at once.
 */
import { describe, expect, it } from 'vitest';
import {
  applicableAt,
  decideRetention,
  DOWNGRADE_NOTICE_MS,
  effectiveHistoryDays,
  purgeHorizon,
  type PendingShortening,
} from '../../src/index.js';
import { DAY, NOW } from './helpers.js';

const MIN = 60 * 1000;

describe('effectiveHistoryDays', () => {
  it('takes the plan, shortened but never lengthened by the override (acceptance 4)', () => {
    expect(effectiveHistoryDays(7, null)).toBe(7);
    expect(effectiveHistoryDays(7, 30)).toBe(7);
    expect(effectiveHistoryDays(7, 3)).toBe(3);
    expect(effectiveHistoryDays(30, 30)).toBe(30);
    expect(effectiveHistoryDays(0, null)).toBe(0); // the free plan
    expect(effectiveHistoryDays(0, 3)).toBe(0);
    expect(effectiveHistoryDays(30, 0)).toBe(0);
  });

  it('refuses days that are not whole numbers', () => {
    expect(() => effectiveHistoryDays(-1, null)).toThrow(RangeError);
    expect(() => effectiveHistoryDays(1.5, null)).toThrow(RangeError);
    expect(() => effectiveHistoryDays(7, -2)).toThrow(RangeError);
  });

  it('measures the horizon back from now', () => {
    expect(purgeHorizon(NOW, 7).getTime()).toBe(NOW.getTime() - 7 * DAY);
    expect(purgeHorizon(NOW, 0).getTime()).toBe(NOW.getTime());
  });
});

describe('decideRetention', () => {
  const pending = (over: Partial<PendingShortening> = {}): PendingShortening => ({
    oldDays: 30,
    newDays: 7,
    effectiveAt: new Date(NOW.getTime() + DOWNGRADE_NOTICE_MS),
    noticeSentAt: NOW,
    emailSentAt: NOW,
    ...over,
  });

  it('takes the effective days as the baseline of a workspace seen first, without notice', () => {
    expect(decideRetention({ baseline: null, pending: null }, 7, NOW)).toEqual({
      enforceDays: 7,
      change: { kind: 'set_baseline', days: 7 },
    });
  });

  it('keeps the old days for 7 days after a drop, then applies the new ones (± 5 min)', () => {
    const first = decideRetention({ baseline: 30, pending: null }, 7, NOW);
    expect(first.enforceDays).toBe(30);
    expect(first.change).toEqual({
      kind: 'announce',
      pending: {
        oldDays: 30,
        newDays: 7,
        effectiveAt: new Date(NOW.getTime() + 7 * DAY),
        noticeSentAt: null,
        emailSentAt: null,
      },
    });
    const announced = first.change.kind === 'announce' ? first.change.pending : pending();
    const state = { baseline: 30, pending: announced };
    const told = { ...announced, noticeSentAt: NOW, emailSentAt: NOW };
    const toldState = { baseline: 30, pending: told };
    const early = new Date(announced.effectiveAt.getTime() - 5 * MIN);
    expect(decideRetention(toldState, 7, early)).toEqual({
      enforceDays: 30,
      change: { kind: 'none' },
    });
    // A run starting up to 4 minutes earlier in its slot still applies it.
    const slot = new Date(announced.effectiveAt.getTime() - 4 * MIN);
    expect(decideRetention(toldState, 7, slot).change).toEqual({ kind: 'apply', days: 7 });
    const late = new Date(announced.effectiveAt.getTime() + 5 * MIN);
    expect(decideRetention(toldState, 7, late)).toEqual({
      enforceDays: 7,
      change: { kind: 'apply', days: 7 },
    });
    // History never applies a shortening whose notice or email is still owed; audit does.
    expect(decideRetention(state, 7, late)).toEqual({ enforceDays: 30, change: { kind: 'none' } });
    expect(decideRetention(state, 7, late, { requireNotice: false }).change).toEqual({
      kind: 'apply',
      days: 7,
    });
  });

  it('counts the 7 days from the later of the notice and the email', () => {
    const effectiveAt = new Date(NOW.getTime() + 7 * DAY);
    const p = pending({
      effectiveAt,
      noticeSentAt: NOW,
      emailSentAt: new Date(NOW.getTime() + DAY),
    });
    expect(applicableAt(p, true)).toEqual(new Date(NOW.getTime() + 8 * DAY));
    expect(applicableAt({ ...p, emailSentAt: null }, true)).toBeNull();
    expect(applicableAt({ ...p, emailSentAt: null }, false)).toEqual(effectiveAt);
    expect(applicableAt({ ...p, emailSentAt: NOW }, true)).toEqual(effectiveAt);
  });

  it('withdraws a shortening when retention is back to the old days or more, enforcing it now', () => {
    expect(decideRetention({ baseline: 30, pending: pending() }, 30, NOW)).toEqual({
      enforceDays: 30,
      change: { kind: 'withdraw', days: 30 },
    });
    expect(decideRetention({ baseline: 30, pending: pending() }, 90, NOW)).toEqual({
      enforceDays: 90,
      change: { kind: 'withdraw', days: 90 },
    });
  });

  it('restarts the notice for a further drop, keeps the time for a partial rise', () => {
    const further = decideRetention({ baseline: 30, pending: pending() }, 3, NOW);
    expect(further.enforceDays).toBe(30);
    expect(further.change).toMatchObject({
      kind: 'announce',
      pending: { oldDays: 30, newDays: 3, noticeSentAt: null, emailSentAt: null },
    });
    expect(decideRetention({ baseline: 30, pending: pending() }, 14, NOW)).toEqual({
      enforceDays: 30,
      change: { kind: 'update_pending', newDays: 14 },
    });
  });

  it('applies a rise at once, and changes nothing when retention stays', () => {
    expect(decideRetention({ baseline: 7, pending: null }, 30, NOW)).toEqual({
      enforceDays: 30,
      change: { kind: 'set_baseline', days: 30 },
    });
    expect(decideRetention({ baseline: 7, pending: null }, 7, NOW)).toEqual({
      enforceDays: 7,
      change: { kind: 'none' },
    });
  });
});

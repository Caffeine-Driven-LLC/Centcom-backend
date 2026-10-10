/**
 * Delivering signals (B076 test plan "failure-path: Redis down during publish -> job retries and
 * eventually succeeds without duplicate notifications"; guardrail "MUST persist the dedupe row in
 * the same transaction as the decision to fire, and publish after commit via the job, so a crash
 * can only cause a retry, never a missed or duplicated signal"; failure modes "Redis pub/sub
 * publish fails -> job fails and retries with backoff; the SQL row is marked fired_at only after
 * publish succeeds" and "Notification dispatcher unavailable -> retry independently of the relay
 * notice (separate sub-step) so the live-session notice is not delayed"):
 *
 * - the notice publish fails: the evaluation throws (the job retries); the signal row stays with
 *   `fired_at` unset while the notification and webhook went out once; the retry publishes the
 *   notice and nothing else again;
 * - the dispatcher fails: the notice goes out at once; the retry sends the notification only;
 * - a failed `warn` notice holds back the `reached` notice after it (order kept);
 * - a decision that fails commits nothing (no row, nothing sent), and the next one signals;
 * - a signal of a period that has ended is marked, not sent;
 * - a second delivery while one runs sends nothing (the lock);
 * - each mark commits on its own: a mark that fails after an earlier send went out leaves that
 *   send marked, so the retry repeats only the step whose mark failed (with the same dedupe key);
 * - a send that does not answer within its time fails its step (QuotaSendTimeoutError) without
 *   holding up the others, and the retry finishes it;
 * - a level re-armed and claimed again gets a new notification dedupe key, so B063 does not drop
 *   it as a repeat of the first.
 */
import { describe, expect, it } from 'vitest';
import {
  QuotaDeliveryError,
  QuotaSendTimeoutError,
} from '../../../src/modules/billing/quota/service.js';
import { NOW, sent, signalsWith } from './helpers.js';

const down = () => new Error('connect ECONNREFUSED redis.internal:6379');

describe('delivery', () => {
  it('retries a notice Redis refused without sending anything else twice', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    ctx.notices.failures.push(down());
    const failed = await ctx.signals.evaluateQuota(ctx.ws, NOW).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(QuotaDeliveryError);
    expect((failed as QuotaDeliveryError).step).toBe('notice');
    const row = [...ctx.store.rows.values()][0];
    expect(row).toMatchObject({ level: 'warn', firedAt: null });
    expect(row?.notifiedAt).toEqual(NOW);
    expect(row?.webhookAt).toEqual(NOW);
    expect(sent(ctx)).toEqual({
      notices: [],
      notifications: ['usage_warning:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80'],
    });
    expect(
      ctx.captured.lines().find((l) => l['msg'] === 'quota.signal_delivery_failed'),
    ).toMatchObject({ step: 'notice', level: 'warn', error: 'Error' });
    expect(JSON.stringify(ctx.captured.lines())).not.toContain('redis.internal');

    // The job's retry.
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: ['usage_warning:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80'],
    });
    expect([...ctx.store.rows.values()][0]?.firedAt).toEqual(NOW);
  });

  it('sends the notice at once when the dispatcher is down, and the notification on retry', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    ctx.notify.failures.push(down(), down());
    await expect(ctx.signals.evaluateQuota(ctx.ws, NOW)).rejects.toMatchObject({
      step: 'notification',
    });
    expect(sent(ctx).notices).toEqual(['usage_warning']);
    expect(sent(ctx).webhooks).toEqual(['hosted_minutes_month:80']);
    await expect(ctx.signals.deliver(ctx.ws, NOW)).rejects.toBeInstanceOf(QuotaDeliveryError);
    expect(await ctx.signals.deliver(ctx.ws, NOW)).toBe(1);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: ['usage_warning:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80'],
    });
    expect(await ctx.signals.deliver(ctx.ws, NOW)).toBe(0);
  });

  it('holds back the reached notice behind a warning that failed', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 7000);
    ctx.notices.failures.push(down());
    await expect(ctx.signals.evaluateQuota(ctx.ws, NOW)).rejects.toBeInstanceOf(QuotaDeliveryError);
    expect(sent(ctx).notices).toEqual([]);
    expect(await ctx.signals.deliver(ctx.ws, NOW)).toBe(2);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);
  });

  it('commits nothing when the decision fails, and signals on the next evaluation', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    ctx.store.failNextDecide(new Error('connection terminated'));
    await expect(ctx.signals.evaluateQuota(ctx.ws, NOW)).rejects.toThrow('connection terminated');
    expect(ctx.store.rows.size).toBe(0);
    expect(sent(ctx).notices).toEqual([]);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(sent(ctx).notices).toEqual(['usage_warning']);
  });

  it('marks signals of a period that has ended without sending them', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    ctx.notices.failures.push(down());
    ctx.notify.failures.push(down());
    ctx.webhooks.failures.push(down());
    await expect(ctx.signals.evaluateQuota(ctx.ws, NOW)).rejects.toBeInstanceOf(QuotaDeliveryError);
    const december = new Date('2026-12-02T00:00:00.000Z');
    expect(await ctx.signals.deliver(ctx.ws, december)).toBe(0);
    expect(sent(ctx)).toEqual({ notices: [], notifications: [], webhooks: [] });
    expect([...ctx.store.rows.values()][0]).toMatchObject({
      firedAt: december,
      notifiedAt: december,
      webhookAt: december,
    });
  });

  it('sends nothing from a second delivery while one runs', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = ctx.notices.port.publish;
    ctx.notices.port.publish = async (ws, notice) => {
      await gate;
      return publish(ws, notice);
    };
    const first = ctx.signals.evaluateQuota(ctx.ws, NOW);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await ctx.signals.deliver(ctx.ws, NOW)).toBe(0);
    release();
    await first;
    expect(sent(ctx).notices).toEqual(['usage_warning']);
    expect(ctx.recorded.count('quota_signal_deliveries_total', { step: 'notice' })).toBe(1);
  });

  it('keeps an earlier send marked when a later mark fails, and repeats only that step', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    ctx.store.failMark('notification', new Error('connection terminated unexpectedly'));
    await expect(ctx.signals.evaluateQuota(ctx.ws, NOW)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
    expect([...ctx.store.rows.values()][0]).toMatchObject({
      firedAt: NOW,
      notifiedAt: null,
      webhookAt: null,
    });
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: ['usage_warning:hosted_minutes_month'],
      webhooks: [],
    });

    // The job's retry: the notice is not sent again.
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: ['usage_warning:hosted_minutes_month', 'usage_warning:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80'],
    });
    // The repeated notification is the one in flight; B063 drops it by its dedupe key.
    const [first, again] = ctx.notify.events;
    expect(again?.dedupeKey).toBe(first?.dedupeKey);
  });

  it('gives up on a send that does not answer in time, and finishes it on retry', async () => {
    const ctx = signalsWith({ sendTimeoutMs: 50 });
    ctx.counters.set(ctx.ws, 4800);
    const publish = ctx.notify.port.publish;
    ctx.notify.port.publish = () => new Promise<string>(() => undefined); // never answers
    const failed = await ctx.signals.evaluateQuota(ctx.ws, NOW).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(QuotaDeliveryError);
    expect((failed as QuotaDeliveryError).step).toBe('notification');
    expect((failed as QuotaDeliveryError).cause).toBeInstanceOf(QuotaSendTimeoutError);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: [],
      webhooks: ['hosted_minutes_month:80'],
    });
    expect(
      ctx.captured.lines().find((l) => l['msg'] === 'quota.signal_delivery_failed'),
    ).toMatchObject({ step: 'notification', error: 'QuotaSendTimeoutError' });

    ctx.notify.port.publish = publish;
    expect(await ctx.signals.deliver(ctx.ws, NOW)).toBe(1);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: ['usage_warning:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80'],
    });
  });

  it('gives a level claimed again after a re-arm a new notification dedupe key', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 6000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: 7000 }); // reached re-arms
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    ctx.counters.set(ctx.ws, 7000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    const reached = ctx.notify.events.filter((e) => e.category === 'quota_reached');
    expect(reached).toHaveLength(2);
    expect(reached[1]?.dedupeKey).not.toBe(reached[0]?.dedupeKey);
    for (const event of reached) {
      expect(event.dedupeKey).toMatch(
        new RegExp(
          `^quota:${ctx.ws}:hosted_minutes_month:2026-10-01T00:00:00\\.000Z:reached:\\d+$`,
        ),
      );
    }
  });
});

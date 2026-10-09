/**
 * The whole chain in one process (B076 build_against "synthetic usage aggregates"; scope "BullMQ
 * job quota-signals.evaluate (enqueued by usage-aggregate updates ...)"): the relay's hosted
 * minutes, B075's real `UsageAggregator` and `QuotaService` (wrapped by `withQuotaSignals`), B069's
 * real `EntitlementService` (a Pro workspace: 6 000 hosted minutes), and `QuotaSignals`:
 *
 * - an aggregate run that moves a workspace's usage queues its evaluation, once per run;
 * - 4 800 minutes (80 %) make one `usage_warning` notice with `resets_at` the subscription
 *   period's end, then 6 000 one `quota_reached`; `getWarnings` follows; B075's own crossings and
 *   rev bumps still happen.
 *
 * `quotaWarningsReader` (B069's `warnings[]` from the stored signals) is tested in
 * `quota.state.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { QuotaSignals } from '../../../src/modules/billing/quota/service.js';
import { memoryQuotaStateCache } from '../../../src/modules/billing/quota/state-cache.js';
import { withQuotaSignals } from '../../../src/modules/billing/quota/triggers.js';
import { UsageAggregator } from '../../../src/modules/usage/aggregate.js';
import { calendarMonth } from '../../../src/modules/usage/period.js';
import { usageHarness } from '../../usage/aggregation/helpers.js';
import {
  memoryQuotaSignalStore,
  recordingNotices,
  recordingNotify,
  recordingWebhooks,
} from './helpers.js';

describe('usage to signals', () => {
  it('queues an evaluation per aggregate run and signals at 80 % and 100 %', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const month = calendarMonth(new Date(h.clock.now));
    await h.subscribe(ws, 'pro', month);

    const store = memoryQuotaSignalStore();
    const notices = recordingNotices();
    const signals = new QuotaSignals({
      store: store.store,
      counters: h.counters,
      entitlements: h.service,
      cache: memoryQuotaStateCache(h.clock.read).cache,
      notices: notices.port,
      notify: recordingNotify().port,
      emitWebhook: recordingWebhooks().emit,
      clock: h.clock.read,
    });
    const queued: string[] = [];
    const aggregator = new UsageAggregator({
      counters: h.counters,
      periods: {
        async period(workspaceId) {
          const ent = await h.service.get(workspaceId);
          return ent?.period === undefined
            ? null
            : { start: new Date(ent.period.start), end: new Date(ent.period.end) };
        },
      },
      relay: h.relay,
      quota: withQuotaSignals(h.quota, (w) => {
        queued.push(w);
        return Promise.resolve();
      }),
      clock: h.clock.read,
    });
    const run = async () => {
      queued.length = 0;
      await aggregator.run();
      for (const w of queued) await signals.evaluateQuota(w);
    };

    h.relay.record(ws, 'hosted_minutes', 4799);
    await run();
    expect(queued).toEqual([ws]);
    expect(notices.published).toEqual([]);

    h.relay.record(ws, 'hosted_minutes', 1);
    await run();
    expect(notices.published.map((p) => p.notice)).toEqual([
      {
        code: 'usage_warning',
        level: 'warn',
        params: { pct: 80, resets_at: month.end.toISOString() },
      },
    ]);
    expect(await signals.getWarnings(ws)).toEqual([{ limit: 'hosted_minutes_month', pct: 80 }]);
    expect(h.emitted.map((e) => e.pct)).toEqual([80]);

    h.relay.record(ws, 'hosted_minutes', 1200);
    await run();
    await run();
    expect(notices.published.map((p) => p.notice.code)).toEqual(['usage_warning', 'quota_reached']);
    expect(await signals.getQuotaState(ws)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
  });
});

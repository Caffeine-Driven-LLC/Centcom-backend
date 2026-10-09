/**
 * What starts an evaluation (B076 scope "BullMQ job quota-signals.evaluate (enqueued by
 * usage-aggregate updates, debounced 10 s per workspace) plus a 60 s sweep job"; config
 * `QUOTA_WARN_PCT=80 (fixed by contract, validated)`, `QUOTA_EVAL_DEBOUNCE_MS=10000`,
 * `QUOTA_SWEEP_INTERVAL_S=60`):
 *
 * - `withQuotaSignals` hands B075's crossings through and queues the workspace after every check
 *   the aggregator makes (also when the check failed); a queue that fails is logged, never the
 *   aggregator's problem (with the real aggregator: `quota.chain.test.ts`);
 * - `subscribeEntitlementChanges` queues the workspace of each of B069's announcements and ignores
 *   anything else on the channel;
 * - `sweepQuota` queues every candidate, page by page;
 * - the configuration's defaults, and its refusals (QUOTA_WARN_PCT other than 80, out of range).
 */
import { ConfigError, createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { loadQuotaSignalConfig } from '../../../src/modules/billing/quota/config.js';
import {
  subscribeEntitlementChanges,
  sweepQuota,
  withQuotaSignals,
} from '../../../src/modules/billing/quota/triggers.js';
import { ENTITLEMENTS_INVALIDATE_CHANNEL } from '../../../src/modules/entitlements/ports.js';
import { captureLogger } from '../../helpers.js';
import { newId } from './helpers.js';

describe('withQuotaSignals', () => {
  it('queues the workspace after each crossing check, whatever the check found', async () => {
    const queued: string[] = [];
    const ws = newId('wsp');
    const crossed = [
      { workspace: ws, limit: 'hosted_minutes_month' as const, pct: 80 as const, resets_at: 'x' },
    ];
    let fail = false;
    const quota = withQuotaSignals(
      {
        detectCrossings: () =>
          fail ? Promise.reject(new Error('bump failed')) : Promise.resolve(crossed),
      },
      (w) => {
        queued.push(w);
        return Promise.resolve();
      },
    );
    expect(await quota.detectCrossings(ws, new Date())).toBe(crossed);
    fail = true;
    await expect(quota.detectCrossings(ws, new Date())).rejects.toThrow('bump failed');
    expect(queued).toEqual([ws, ws]);
  });

  it('logs a queue that fails and answers the crossings all the same', async () => {
    const captured = captureLogger();
    const ws = newId('wsp');
    const quota = withQuotaSignals(
      { detectCrossings: () => Promise.resolve([]) },
      () => Promise.reject(new Error('connect ECONNREFUSED redis.internal')),
      captured.logger,
    );
    expect(await quota.detectCrossings(ws, new Date())).toEqual([]);
    expect(captured.lines()).toEqual([
      expect.objectContaining({ msg: 'quota.enqueue_failed', workspace_id: ws, error: 'Error' }),
    ]);
    expect(captured.raw()).not.toContain('redis.internal');
  });
});

describe('subscribeEntitlementChanges', () => {
  it('queues the workspace of each announcement and ignores the rest', async () => {
    const redis = createMemoryRedis();
    const queued: string[] = [];
    const stop = await subscribeEntitlementChanges(redis.pubsub, (w) => {
      queued.push(w);
      return Promise.resolve();
    });
    const ws = newId('wsp');
    await redis.pubsub.publish(
      ENTITLEMENTS_INVALIDATE_CHANNEL,
      JSON.stringify({ workspace: ws, rev: 4 }),
    );
    await redis.pubsub.publish(ENTITLEMENTS_INVALIDATE_CHANNEL, 'not json');
    await redis.pubsub.publish(
      ENTITLEMENTS_INVALIDATE_CHANNEL,
      JSON.stringify({ workspace: 'wsp_x' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queued).toEqual([ws]);
    await stop();
    await redis.close();
  });
});

describe('sweepQuota', () => {
  it('queues every candidate, page by page', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `wsp_${String(i).padStart(26, '0')}`);
    const pages: (string | null)[] = [];
    const queued: string[] = [];
    const count = await sweepQuota({
      store: {
        sweepCandidates: (after, limit) => {
          pages.push(after);
          const start = after === null ? 0 : ids.indexOf(after) + 1;
          return Promise.resolve(ids.slice(start, start + limit));
        },
      },
      enqueue: (w) => {
        queued.push(w);
        return Promise.resolve();
      },
      now: new Date(),
      batch: 3,
    });
    expect(count).toBe(7);
    expect(queued).toEqual(ids);
    expect(pages).toEqual([null, ids[2], ids[5]]);
  });
});

describe('loadQuotaSignalConfig', () => {
  it('defaults to 80 %, 10 s and 60 s, and refuses anything but 80 % or out-of-range values', () => {
    expect(loadQuotaSignalConfig({})).toEqual({
      warnPct: 80,
      debounceMs: 10_000,
      sweepIntervalS: 60,
    });
    expect(
      loadQuotaSignalConfig({ QUOTA_EVAL_DEBOUNCE_MS: '0', QUOTA_SWEEP_INTERVAL_S: '3600' }),
    ).toEqual({ warnPct: 80, debounceMs: 0, sweepIntervalS: 3600 });
    for (const env of [
      { QUOTA_WARN_PCT: '75' },
      { QUOTA_WARN_PCT: '80.5' },
      { QUOTA_EVAL_DEBOUNCE_MS: '60001' },
      { QUOTA_SWEEP_INTERVAL_S: '9' },
    ]) {
      let error: unknown;
      try {
        loadQuotaSignalConfig(env);
      } catch (err) {
        error = err;
      }
      expect(error, JSON.stringify(env)).toBeInstanceOf(ConfigError);
      expect(String((error as Error).message)).toContain(Object.keys(env)[0]);
    }
  });
});

/**
 * The `notify.push` job (B064): a job runs the delivery once; deliveries a provider's open circuit
 * deferred are queued again for those subscriptions only, delayed until the circuit closes (not
 * dropped), counted and logged without the payload; a job with nothing deferred adds nothing. On
 * Redis 7 (REDIS_URL, CI's integration job): a real worker runs a job and leaves the deferred one
 * waiting in the delayed set, with a job id BullMQ accepts.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  defineConfig,
  NOTIFY_PUSH_QUEUE,
  notifyPushJobOptions,
  z,
  type NotifyPushJobData,
} from '@centcom/core';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  createNotifyPushQueue,
  processNotifyPush,
  startNotifyPushWorker,
} from '../src/jobs/notify-push.js';

const data: NotifyPushJobData = {
  userId: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  payload: { id: 'ntf_01JA3Z8K2M5N7P9Q0R1S2T3V4W', category: 'approval_needed', body_key: 'k' },
};

describe('processNotifyPush', () => {
  it('runs the delivery and adds nothing when nothing was deferred', async () => {
    const added: unknown[] = [];
    const report = await processNotifyPush(
      { id: 'push-1', data },
      {
        process: () => Promise.resolve({}),
        queue: { add: (...args: unknown[]) => Promise.resolve(added.push(args)) as never },
      },
    );
    expect(report).toEqual({});
    expect(added).toEqual([]);
  });

  it('re-queues deferred deliveries for those subscriptions only, delayed', async () => {
    const added: {
      name: string;
      data: NotifyPushJobData;
      opts: { delay: number; jobId: string };
    }[] = [];
    const lines: string[] = [];
    await processNotifyPush(
      { id: 'push-ntf_1-usr_1', data },
      {
        process: () =>
          Promise.resolve({
            deferred: { subscriptionIds: ['psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W'], delayMs: 42_000 },
          }),
        queue: {
          add: ((name: string, d: NotifyPushJobData, opts: { delay: number; jobId: string }) => {
            added.push({ name, data: d, opts });
            return Promise.resolve();
          }) as never,
        },
        logger: {
          info: (obj: unknown, msg: string) => lines.push(`${msg} ${JSON.stringify(obj)}`),
        } as never,
      },
    );
    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe(NOTIFY_PUSH_QUEUE);
    expect(added[0]?.data).toEqual({
      ...data,
      subscriptionIds: ['psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W'],
    });
    expect(added[0]?.opts).toMatchObject({ ...notifyPushJobOptions(), delay: 42_000 });
    expect(added[0]?.opts.jobId).not.toContain(':');
    expect(lines.join('\n')).toContain('push.deferred');
    expect(lines.join('\n')).not.toContain('approval_needed');
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

describe.runIf(REDIS_URL !== undefined)('notify.push on Redis 7', () => {
  it('runs a job and leaves its deferred deliveries delayed', async () => {
    const prefix = `push-test-${randomBytes(4).toString('hex')}`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createNotifyPushQueue(connection);
    const ran: NotifyPushJobData[] = [];
    const worker = startNotifyPushWorker(connection, {
      process: (d) => {
        ran.push(d);
        return Promise.resolve(
          d.subscriptionIds === undefined
            ? { deferred: { subscriptionIds: ['psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W'], delayMs: 60_000 } }
            : {},
        );
      },
      queue,
    });
    try {
      await queue.add(NOTIFY_PUSH_QUEUE, data, {
        ...notifyPushJobOptions(),
        jobId: `${prefix}-ntf_1-usr_1`,
      });
      const deadline = Date.now() + 10_000;
      while ((await queue.getDelayedCount()) === 0 && Date.now() < deadline) await sleep(50);
      expect(ran).toHaveLength(1);
      const delayed = await queue.getDelayed();
      expect(delayed.map((j) => j.data.subscriptionIds)).toContainEqual([
        'psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      ]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  }, 30_000);
});

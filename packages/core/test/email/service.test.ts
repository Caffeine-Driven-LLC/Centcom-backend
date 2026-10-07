/**
 * The email service (B032; card tests email.ratelimit.test.ts, email.idempotency.test.ts and
 * email.logging.test.ts, and the failure modes): what is queued, the per-recipient limit
 * (acceptance 4), idempotency keys (acceptance 6, before the queue), what is logged (acceptance 7),
 * unknown templates failing at enqueue, and Redis or the queue failing as a retryable 503 with no
 * inline send.
 */
import { describe, expect, it } from 'vitest';
import {
  AppError,
  createTemplateRegistry,
  EMAIL_QUEUE,
  EMAIL_RATE_WINDOW_S,
  type KeyValue,
} from '../../src/index.js';
import { params, setup, token } from './helpers.js';

describe('send', () => {
  it('renders, checks and queues the email for the worker', async () => {
    const { service, queue } = setup();
    const invite = params.workspace_invite();
    const result = await service.send('workspace_invite', 'Ada@Example.TEST', invite);
    expect(result).toEqual({
      queued: true,
      jobId: expect.stringMatching(/^email-[0-9a-f]{32}$/) as string,
    });
    expect(queue.jobs).toHaveLength(1);
    const [job] = queue.jobs;
    expect(job?.name).toBe(EMAIL_QUEUE);
    expect(job?.jobId).toBe(result.jobId);
    // Retries travel with the job, whatever queue a producer uses.
    expect(job?.opts).toEqual({
      jobId: result.jobId,
      attempts: 5,
      backoff: { type: 'email' },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    expect(job?.data.template).toBe('workspace_invite');
    expect(job?.data.email).toMatchObject({
      to: 'ada@example.test',
      from: 'Centcom <no-reply@centcom.test>',
      subject: 'Ada Lovelace invited you to Analytical Engines on Centcom',
      tag: 'workspace_invite',
    });
    expect(job?.data.email.text).toContain(invite.url);
  });

  it('fails an unknown template at enqueue time, queueing nothing', async () => {
    const { service, queue } = setup();
    await expect(
      service.send('nope' as 'export_ready', 'a@example.test', params.export_ready()),
    ).rejects.toThrow(TypeError);
    expect(() => service.render('nope' as 'export_ready', params.export_ready())).toThrow(
      TypeError,
    );
    expect(queue.jobs).toEqual([]);
  });

  it('refuses a bad sender at construction', () => {
    expect(() => setup({ from: 'not a sender' })).toThrow(TypeError);
  });

  it('renders templates registered on its registry', async () => {
    const templates = createTemplateRegistry();
    const { service, queue } = setup({ templates });
    expect(service.templates).toBe(templates);
    await service.send('export_ready', 'a@example.test', params.export_ready());
    expect(queue.jobs).toHaveLength(1);
  });
});

describe('the per-recipient limit (acceptance 4)', () => {
  it('refuses the 6th email of a template to an address within an hour with a 429 and retry_after_s', async () => {
    const { service, queue, clock, counters } = setup();
    for (let i = 0; i < 5; i++)
      await service.send('export_ready', 'ada@example.test', params.export_ready());
    clock.advance(10 * 60 * 1000);
    let error: unknown;
    try {
      await service.send('export_ready', 'ADA@example.test', params.export_ready());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterS: EMAIL_RATE_WINDOW_S - 600,
    });
    expect(queue.jobs).toHaveLength(5);
    expect(counters.count('email_rate_limited_total')).toBe(1);
    // Other templates and other addresses have their own limits; the window slides.
    await service.send(
      'account_deletion_scheduled',
      'ada@example.test',
      params.account_deletion_scheduled(),
    );
    await service.send('export_ready', 'grace@example.test', params.export_ready());
    clock.advance(50 * 60 * 1000);
    await service.send('export_ready', 'ada@example.test', params.export_ready());
    expect(queue.jobs).toHaveLength(8);
  });
});

describe('idempotency keys (acceptance 6)', () => {
  it('queue one email for the same key, template and recipient within 24 hours', async () => {
    const { service, queue, clock } = setup();
    const key = token();
    const first = await service.send('export_ready', 'ada@example.test', params.export_ready(), {
      idempotencyKey: key,
    });
    const second = await service.send('export_ready', 'Ada@Example.test', params.export_ready(), {
      idempotencyKey: key,
    });
    expect(second).toEqual(first);
    expect(queue.jobs).toHaveLength(1);
    expect(first.jobId).toMatch(/^email-[0-9a-f]{32}$/);
    // Another recipient or template with the same key is another email.
    await service.send('export_ready', 'grace@example.test', params.export_ready(), {
      idempotencyKey: key,
    });
    await service.send(
      'account_deletion_scheduled',
      'ada@example.test',
      params.account_deletion_scheduled(),
      {
        idempotencyKey: key,
      },
    );
    expect(queue.jobs).toHaveLength(3);
    // Delivered jobs leave the queue (BullMQ removes them), so from here only the remembered key
    // stops a resend: one hour later the same key still queues nothing.
    queue.jobs.length = 0;
    clock.advance(60 * 60 * 1000);
    const again = await service.send('export_ready', 'ada@example.test', params.export_ready(), {
      idempotencyKey: key,
    });
    expect(again).toEqual(first);
    expect(queue.jobs).toEqual([]);
    // After 24 hours the key is forgotten, and the email goes out again.
    clock.advance(23 * 60 * 60 * 1000);
    await service.send('export_ready', 'ada@example.test', params.export_ready(), {
      idempotencyKey: key,
    });
    expect(queue.jobs).toHaveLength(1);
  });

  it('let the queue drop a concurrent duplicate by job id', async () => {
    const { service, queue } = setup();
    const key = token();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        service.send('export_ready', 'ada@example.test', params.export_ready(), {
          idempotencyKey: key,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it.each(['', 'x'.repeat(201), 'a\u0000b'])('refuse the key %j', async (key) => {
    const { service } = setup();
    await expect(
      service.send('export_ready', 'a@example.test', params.export_ready(), {
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: '/idempotencyKey' }],
    });
  });

  it('still report success when the key cannot be remembered after queueing', async () => {
    const base = setup();
    const kv: KeyValue = { ...base.backend.kv, set: () => Promise.reject(new Error('kv down')) };
    const s = setup({ kv });
    const result = await s.service.send('export_ready', 'a@example.test', params.export_ready(), {
      idempotencyKey: token(),
    });
    expect(result.queued).toBe(true);
    expect(s.queue.jobs).toHaveLength(1);
    expect(s.counters.count('email_idempotency_unrecorded_total')).toBe(1);
    expect(s.log.lines().some((l) => l['msg'] === 'email.idempotency_unrecorded')).toBe(true);
  });
});

describe('when Redis or the queue fails', () => {
  const down = (): Promise<never> =>
    Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:6379'));

  it.each(['queue', 'rate limiter', 'key-value store'] as const)(
    'answers a retryable 503 when the %s is down, and sends nothing inline',
    async (part) => {
      const base = setup();
      const s = setup({
        queue: base.queue,
        ...(part === 'rate limiter' ? { rateLimit: { consume: down } } : {}),
        ...(part === 'key-value store' ? { kv: { ...base.backend.kv, get: down } } : {}),
      });
      if (part === 'queue') base.queue.down = true;
      let error: unknown;
      try {
        await s.service.send('export_ready', 'a@example.test', params.export_ready(), {
          idempotencyKey: token(),
        });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'service_unavailable', status: 503, retryAfterS: 1 });
      expect(JSON.stringify(error)).not.toContain('10.1.2.3');
      expect(base.queue.jobs).toEqual([]);
    },
  );
});

describe('logging (acceptance 7)', () => {
  it('logs the template and job id, never the recipient, a parameter or a link', async () => {
    const { service, log } = setup();
    const invite = params.workspace_invite();
    const { jobId } = await service.send('workspace_invite', 'ada@example.test', invite);
    expect(log.lines()).toEqual([
      expect.objectContaining({ msg: 'email.queued', template: 'workspace_invite', job_id: jobId }),
    ]);
    for (const secret of [
      'ada@example.test',
      invite.url,
      invite.inviterName,
      invite.workspaceName,
    ]) {
      expect(log.raw()).not.toContain(secret);
    }
  });
});

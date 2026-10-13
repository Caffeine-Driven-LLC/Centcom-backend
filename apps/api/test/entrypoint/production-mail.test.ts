/**
 * Production sign-in mail: EMAIL_PROVIDER (postmark, resend, brevo, smtp) turns e-mail sign-in
 * and invites on without Mailpit; the API queues through B032's email service and the worker's
 * `processEmailJob` delivers with the chosen provider. The whole path runs here against a local
 * HTTP stand-in of Resend, with no Postgres.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  ConfigError,
  createEmailService,
  createMemoryRedis,
  ResendProvider,
  Secret,
  type EmailJobData,
  type EmailJobOptions,
  type EmailQueue,
} from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import { processEmailJob } from '@centcom/worker';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import type { ApiDatabase } from '../../src/context.js';
import { emailMagicLinkMailer } from '../../src/modules/auth/magic-link/mailer.js';
import { captureLogger } from '../helpers.js';
import { testEnv } from './helpers.js';

const FROM = 'Centcom <no-reply@centcom.test>';
const mail = (extra: Record<string, string | undefined>) =>
  testEnv({ DEV_MAILPIT_URL: undefined, EMAIL_FROM: FROM, ...extra });

describe('production mail configuration', () => {
  it.each([
    ['postmark', { POSTMARK_SERVER_TOKEN: 'pm' }],
    ['resend', { RESEND_API_KEY: 're' }],
    ['brevo', { BREVO_API_KEY: 'br' }],
    ['smtp', { SMTP_HOST: 'smtp.example.test' }],
  ])('%s turns e-mail sign-in on without Mailpit', (provider, keys) => {
    const config = loadApiConfig(mail({ EMAIL_PROVIDER: provider, ...keys }));
    expect(config.email?.provider).toBe(provider);
    expect(config.magicLink).not.toBeNull();
    expect(config.mailpitUrl).toBeNull();
  });

  it('keeps sign-in off for console, memory and an unset provider', () => {
    for (const provider of ['console', 'memory', undefined]) {
      const config = loadApiConfig(mail({ EMAIL_PROVIDER: provider }));
      expect(config.email).toBeNull();
      expect(config.magicLink).toBeNull();
    }
  });

  it('refuses a chosen provider without its key, naming the key and not the value', () => {
    expect(() => loadApiConfig(mail({ EMAIL_PROVIDER: 'resend' }))).toThrow(ConfigError);
    try {
      loadApiConfig(mail({ EMAIL_PROVIDER: 'brevo', EMAIL_FROM: 'broken' }));
    } catch (e) {
      expect(String(e)).toContain('EMAIL_FROM');
      expect(String(e)).not.toContain('broken');
    }
  });
});

describe('the API with a queued email service', () => {
  it('serves the sign-in and invite routes when the email queue is given', async () => {
    const queue: EmailQueue = { add: (_n, _d, o) => Promise.resolve({ id: o.jobId }) };
    const db = createDb<ApiDatabase>({
      url: 'postgres://centcom:test@127.0.0.1:1/none',
      poolMax: 1,
      connectTimeoutMs: 300,
    });
    const app = await buildApp({
      config: loadApiConfig(mail({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're' })),
      db,
      redis: createMemoryRedis(),
      logger: captureLogger().logger,
      emailQueue: queue,
    });
    await app.ready();
    expect(app.hasRoute({ method: 'POST', url: '/login/email' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/v1/workspaces/:id/invites' })).toBe(true);
    await app.close();
    await closeDb(db);
  });

  it('leaves sign-in out when no queue is given and Mailpit is unset', async () => {
    const db = createDb<ApiDatabase>({
      url: 'postgres://centcom:test@127.0.0.1:1/none',
      poolMax: 1,
      connectTimeoutMs: 300,
    });
    const app = await buildApp({
      config: loadApiConfig(mail({ EMAIL_PROVIDER: 'console' })),
      db,
      redis: createMemoryRedis(),
      logger: captureLogger().logger,
    });
    await app.ready();
    expect(app.hasRoute({ method: 'POST', url: '/login/email' })).toBe(false);
    await app.close();
    await closeDb(db);
  });
});

describe('a sign-in link, queued by the API and delivered by the worker job', () => {
  it('reaches the provider’s API once, with the link intact', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 're_1' }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };

    const jobs: { data: EmailJobData; opts: EmailJobOptions }[] = [];
    const redis = createMemoryRedis();
    const email = createEmailService({
      queue: {
        add: (_n, data, opts) => {
          jobs.push({ data, opts });
          return Promise.resolve({ id: opts.jobId });
        },
      },
      rateLimit: redis.rateLimit,
      kv: redis.kv,
      from: FROM,
    });
    const link = 'https://api.centcom.test/login/email/verify?t=tok123';
    await emailMagicLinkMailer(email, 900).send('Ada@Example.test', link, 'en');
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    const result = await processEmailJob(
      { id: job?.opts.jobId, data: job?.data as EmailJobData, attemptsMade: 0 },
      {
        provider: new ResendProvider({
          apiKey: new Secret('re_key'),
          baseUrl: `http://127.0.0.1:${port}`,
        }),
        kv: redis.kv,
      },
    );
    expect(result.providerMessageId).toBe('re_1');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ from: FROM, to: ['ada@example.test'] });
    expect(String(bodies[0]?.['text'])).toContain(link);
    expect(String(bodies[0]?.['text'])).toContain('15 minutes');

    // BullMQ handing the same job out again must not send a second mail.
    await processEmailJob(
      { id: job?.opts.jobId, data: job?.data as EmailJobData, attemptsMade: 1 },
      {
        provider: new ResendProvider({ apiKey: new Secret('x'), baseUrl: 'http://127.0.0.1:1' }),
        kv: redis.kv,
      },
    );
    expect(bodies).toHaveLength(1);
    server.close();
  });
});

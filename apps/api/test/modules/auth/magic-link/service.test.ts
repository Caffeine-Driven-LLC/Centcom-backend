/**
 * E-mail sign-in (B014, card test service.test.ts): single use (acceptance 2), expiry and the
 * nonce binding (acceptance 3), hash-only storage and logs without tokens, links or addresses
 * (acceptance 8), shared limits and accounts across address spellings (acceptance 7), closed
 * accounts, mail failures, the store down, and the mailer adapter over B032's email service.
 */
import { createHash } from 'node:crypto';
import {
  AppError,
  createEmailService,
  createMemoryRedis,
  EmailProviderError,
  type EmailJobData,
} from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  emailMagicLinkMailer,
  lifetime,
  MAGIC_LINK_TEMPLATE,
} from '../../../../src/modules/auth/magic-link/mailer.js';
import { MagicLinkError } from '../../../../src/modules/auth/magic-link/service.js';
import { csrfFor } from '../../../../src/routes/login-email.js';
import { magicLinkApp, nonceOf, requestLink, tokenOf, useLink } from './helpers.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('a sign-in link', () => {
  it('signs in once; a second use fails exactly like an unknown token (acceptance 2)', async () => {
    const { app, service, mailer, completed } = await magicLinkApp();
    const requested = await requestLink(app, 'ada@example.test');
    expect(requested.statusCode).toBe(202);
    await service.idle();
    const nonce = nonceOf(requested);
    const token = tokenOf(mailer.sent[0]?.link ?? '');
    const first = await useLink(app, token, nonce, csrfFor(nonce));
    expect(first.statusCode).toBe(303);
    expect(first.headers['location']).toBe('https://app.centcom.test/');
    expect(first.headers['x-test-signed-in']).toBe(completed[0]?.userId);
    const again = await useLink(app, token, nonce, csrfFor(nonce));
    const unknown = await useLink(
      app,
      token.replace(/.$/, token.endsWith('A') ? 'B' : 'A'),
      nonce,
      csrfFor(nonce),
    );
    expect(again.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(again.body).toBe(unknown.body);
    expect(again.headers['content-type']).toBe(unknown.headers['content-type']);
    expect(completed).toHaveLength(1);
  });

  it('expires after 15 minutes (acceptance 3)', async () => {
    const { app, service, mailer, clock } = await magicLinkApp();
    const requested = await requestLink(app, 'ada@example.test');
    await requestLink(app, 'grace@example.test', {
      cookie: `centcom_login_nonce=${nonceOf(requested)}`,
    });
    await service.idle();
    const nonce = nonceOf(requested);
    clock.advance(15 * 60 * 1000 - 1);
    expect(
      (await useLink(app, tokenOf(mailer.sent[1]?.link ?? ''), nonce, csrfFor(nonce))).statusCode,
    ).toBe(303);
    clock.advance(1);
    expect(
      (await useLink(app, tokenOf(mailer.sent[0]?.link ?? ''), nonce, csrfFor(nonce))).statusCode,
    ).toBe(400);
  });

  it('works only in the browser that asked for it, and only with its CSRF token (acceptance 3)', async () => {
    const { app, service, mailer } = await magicLinkApp();
    const requested = await requestLink(app, 'ada@example.test');
    const other = nonceOf(await requestLink(app, 'eve@example.test', { ip: '198.51.100.9' }));
    await service.idle();
    const nonce = nonceOf(requested);
    const token = tokenOf(mailer.sent[0]?.link ?? '');
    expect((await useLink(app, token, undefined, csrfFor(nonce))).statusCode).toBe(400);
    expect((await useLink(app, token, other, csrfFor(other))).statusCode).toBe(400);
    expect((await useLink(app, token, nonce, csrfFor(other))).statusCode).toBe(400);
    expect((await useLink(app, token, nonce, '')).statusCode).toBe(400);
    // None of that used the link up.
    expect((await useLink(app, token, nonce, csrfFor(nonce))).statusCode).toBe(303);
  });

  it('keeps only hashes in the store, and no token, link or address in the logs (acceptance 8)', async () => {
    const { app, service, store, mailer, captured } = await magicLinkApp();
    const requested = await requestLink(app, 'Ada@Example.TEST');
    await service.idle();
    const nonce = nonceOf(requested);
    const link = mailer.sent[0]?.link ?? '';
    const token = tokenOf(link);
    await useLink(app, token, nonce, csrfFor(nonce));
    const [row] = store.rows;
    expect(row?.tokenHash).toBe(sha256(token));
    expect(row?.nonceHash).toBe(sha256(nonce));
    expect(JSON.stringify(store.rows)).not.toContain(token);
    expect(JSON.stringify(store.rows)).not.toContain(nonce);
    const logs = captured.raw();
    for (const secret of [token, link, nonce, 'ada@example.test', 'Ada@Example.TEST']) {
      expect(logs).not.toContain(secret);
    }
    const events = captured.lines().map((l) => l['msg']);
    expect(events).toContain('auth.magic_link_sent');
    expect(events).toContain('auth.magic_link_login');
    const sent = captured.lines().find((l) => l['msg'] === 'auth.magic_link_sent');
    expect(sent?.['email_hash']).toBe(sha256('ada@example.test').slice(0, 12));
  });

  it('treats differently cased addresses as one, for limits and the account (acceptance 7)', async () => {
    const { app, service, mailer, users } = await magicLinkApp();
    const browser = nonceOf(await requestLink(app, 'A@Example.com'));
    await requestLink(app, 'a@example.COM', { cookie: `centcom_login_nonce=${browser}` });
    await service.idle();
    expect(mailer.sent.map((m) => m.to)).toEqual(['a@example.com', 'a@example.com']);
    for (const { link } of mailer.sent)
      await useLink(app, tokenOf(link), browser, csrfFor(browser));
    expect([...users.byEmail.keys()]).toEqual(['a@example.com']);
  });

  it('treats NFC-equivalent addresses as one, and counts them against one limit (acceptance 7)', async () => {
    const { app, service, mailer, users } = await magicLinkApp();
    const decomposed = 'José@Example.TEST';
    const composed = 'josé@example.test';
    const browser = nonceOf(await requestLink(app, decomposed, { ip: '198.51.100.1' }));
    for (let i = 0; i < 5; i++) {
      await requestLink(app, i % 2 === 0 ? composed : decomposed, {
        ip: `198.51.100.${i + 2}`,
        cookie: `centcom_login_nonce=${browser}`,
      });
    }
    await service.idle();
    // Six requests, one limit of five; every mail to the one composed address.
    expect(mailer.sent.map((m) => m.to)).toEqual(Array<string>(5).fill(composed));
    for (const { link } of mailer.sent)
      await useLink(app, tokenOf(link), browser, csrfFor(browser));
    expect([...users.byEmail.keys()]).toEqual([composed]);
  });

  it('fails like a bad link for accounts being deleted or deleted', async () => {
    const { app, service, mailer, users, completed } = await magicLinkApp();
    users.byEmail.set('gone@example.test', { id: 'usr_x', status: 'deleted' });
    users.byEmail.set('leaving@example.test', { id: 'usr_y', status: 'pending_deletion' });
    const browser = nonceOf(await requestLink(app, 'gone@example.test'));
    await requestLink(app, 'leaving@example.test', { cookie: `centcom_login_nonce=${browser}` });
    await service.idle();
    for (const { link } of mailer.sent) {
      const response = await useLink(app, tokenOf(link), browser, csrfFor(browser));
      expect(response.statusCode).toBe(400);
    }
    expect(completed).toEqual([]);
  });

  it('gives a link up after 3 failed mail attempts, counted and logged', async () => {
    const { app, service, store, mailer, recorded, captured } = await magicLinkApp();
    mailer.failWith = () => new Error('queue down');
    expect((await requestLink(app, 'ada@example.test')).statusCode).toBe(202);
    await service.idle();
    expect(mailer.attempts).toBe(3);
    expect(store.rows[0]?.usedAt).toBeInstanceOf(Date);
    expect(recorded.count('magic_link_mail_failures_total')).toBe(1);
    expect(captured.lines().some((l) => l['msg'] === 'auth.magic_link_mail_failed')).toBe(true);
  });

  it('does not retry a mail the email service refused, and retries one that failed once', async () => {
    const refused = await magicLinkApp();
    refused.mailer.failWith = () => new AppError('rate_limited', { retryAfterS: 60 });
    await requestLink(refused.app, 'ada@example.test');
    await refused.service.idle();
    expect(refused.mailer.attempts).toBe(1);
    const flaky = await magicLinkApp();
    let calls = 0;
    flaky.mailer.failWith = () => new EmailProviderError('timeout', { retryable: true });
    const realSend = flaky.mailer.send.bind(flaky.mailer);
    flaky.mailer.send = (to, link, locale) => {
      calls += 1;
      if (calls === 2) flaky.mailer.failWith = undefined;
      return realSend(to, link, locale);
    };
    const nonce = nonceOf(await requestLink(flaky.app, 'ada@example.test'));
    await flaky.service.idle();
    expect(flaky.mailer.sent).toHaveLength(1);
    const link = flaky.mailer.sent[0]?.link ?? '';
    expect((await useLink(flaky.app, tokenOf(link), nonce, csrfFor(nonce))).statusCode).toBe(303);
  });

  it('answers 503 with retry_after_s when the token store is down, at either end', async () => {
    const { app, service, store, mailer } = await magicLinkApp();
    const nonce = nonceOf(await requestLink(app, 'ada@example.test'));
    await service.idle();
    store.down = true;
    const asking = await app.inject({
      method: 'POST',
      url: '/login/email',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'grace@example.test' },
    });
    expect(asking.statusCode).toBe(503);
    expect(asking.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    const using = await useLink(app, tokenOf(mailer.sent[0]?.link ?? ''), nonce, csrfFor(nonce));
    expect(using.statusCode).toBe(503);
  });

  it('refuses programming errors and odd input in the service itself', async () => {
    const { service } = await magicLinkApp();
    await expect(
      service.request('ada@example.test', { nonce: 'short', locale: 'en' }),
    ).rejects.toThrow(TypeError);
    await expect(service.consume(42, 'x')).rejects.toBeInstanceOf(MagicLinkError);
    await expect(service.consume('x', 'y')).rejects.toBeInstanceOf(MagicLinkError);
  });
});

describe('the mailer over B032', () => {
  it('registers the magic_link template once and queues the link as given', async () => {
    const backend = createMemoryRedis();
    const jobs: EmailJobData[] = [];
    const email = createEmailService({
      queue: {
        add: (_name, data) => {
          jobs.push(data);
          return Promise.resolve({ id: 'job' });
        },
      },
      rateLimit: backend.rateLimit,
      kv: backend.kv,
      from: 'Centcom <no-reply@centcom.test>',
    });
    const mailer = emailMagicLinkMailer(email, 900);
    emailMagicLinkMailer(email, 900);
    const link = 'https://api.centcom.test/login/email/verify?t=TOKEN';
    await mailer.send('ada@example.test', link, 'en');
    expect(jobs[0]?.template).toBe('magic_link');
    expect(jobs[0]?.email).toMatchObject({
      to: 'ada@example.test',
      subject: 'Your Centcom sign-in link',
    });
    expect(jobs[0]?.email.text).toContain(`Sign in to Centcom: ${link}`);
    expect(jobs[0]?.email.text).toContain('for 15 minutes');
    expect(jobs[0]?.email.html).toContain(`href="${link}"`);
    expect(MAGIC_LINK_TEMPLATE.params).toEqual({ url: 'url', validFor: 'text' });
  });

  it('says how long a link lasts', () => {
    expect([60, 900, 1800, 3600, 7200].map(lifetime)).toEqual([
      '1 minute',
      '15 minutes',
      '30 minutes',
      '1 hour',
      '2 hours',
    ]);
  });
});

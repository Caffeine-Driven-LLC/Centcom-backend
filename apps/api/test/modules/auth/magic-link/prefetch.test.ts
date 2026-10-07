/**
 * Prefetching (B014, card test prefetch.test.ts; acceptance 4): opening a link (a GET, which mail
 * scanners do) only shows a confirm page and changes nothing; the link still works afterwards.
 * Pages are never cached, run no scripts, and post only to this origin.
 */
import { describe, expect, it } from 'vitest';
import { csrfFor, NONCE_COOKIE } from '../../../../src/routes/login-email.js';
import { magicLinkApp, nonceOf, requestLink, tokenOf, useLink } from './helpers.js';

describe('opening a link', () => {
  it('shows a confirm form and changes nothing, however often (acceptance 4)', async () => {
    const { app, service, store, mailer, users } = await magicLinkApp();
    const nonce = nonceOf(await requestLink(app, 'ada@example.test'));
    await service.idle();
    const link = mailer.sent[0]?.link ?? '';
    const before = JSON.stringify(store.rows);
    for (let i = 0; i < 3; i++) {
      const page = await app.inject({
        url: `/login/email/verify?t=${tokenOf(link)}`,
        headers: { cookie: `${NONCE_COOKIE}=${nonce}` },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<form method="post" action="/login/email/verify">');
      expect(page.body).toContain(`name="t" value="${tokenOf(link)}"`);
      expect(page.body).toContain(`name="csrf" value="${csrfFor(nonce)}"`);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['content-security-policy']).toBe(
        "default-src 'none'; form-action 'self'",
      );
      expect(page.headers['referrer-policy']).toBe('no-referrer');
    }
    // A scanner without the cookie gets a page too.
    const scanner = await app.inject({ url: `/login/email/verify?t=${tokenOf(link)}` });
    expect(scanner.statusCode).toBe(400);
    expect(scanner.body).toContain('same browser');
    expect(JSON.stringify(store.rows)).toBe(before);
    expect(users.lookups).toBe(0);
    expect((await useLink(app, tokenOf(link), nonce, csrfFor(nonce))).statusCode).toBe(303);
  });

  it('answers a malformed or missing token with the generic page', async () => {
    const { app } = await magicLinkApp();
    for (const url of [
      '/login/email/verify',
      '/login/email/verify?t=short',
      '/login/email/verify?t=a&t=b',
    ]) {
      const page = await app.inject({ url });
      expect(page.statusCode).toBe(400);
      expect(page.body).toContain('This sign-in link does not work');
    }
  });

  it('escapes what it echoes', async () => {
    const { app } = await magicLinkApp();
    const nonce = 'n'.repeat(43);
    const page = await app.inject({
      url: `/login/email/verify?t=${'"><script>'.padEnd(43, 'x')}`,
      headers: { cookie: `${NONCE_COOKIE}=${nonce}` },
    });
    expect(page.body).not.toContain('<script>');
  });
});

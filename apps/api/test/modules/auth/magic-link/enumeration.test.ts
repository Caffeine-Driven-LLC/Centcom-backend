/**
 * No account enumeration (B014, card test enumeration.test.ts; acceptance 1): asking for a link
 * for an existing account and for an unknown address gives byte-identical responses (status,
 * headers, body) in about the same time, no account is looked up while answering, and every valid
 * address (existing or new) gets a mail; malformed addresses get a 422 and no mail.
 */
import { describe, expect, it } from 'vitest';
import { magicLinkApp, requestLink } from './helpers.js';

/** The response with what legitimately varies per request taken out. */
const comparable = (response: Awaited<ReturnType<typeof requestLink>>) => ({
  status: response.statusCode,
  body: response.body,
  headers: Object.fromEntries(
    Object.entries(response.headers)
      .filter(([name]) => name !== 'x-request-id' && name !== 'date')
      .map(([name, value]) => [
        name,
        name === 'set-cookie' ? String(value).replace(/=[A-Za-z0-9_-]{43};/, '=NONCE;') : value,
      ]),
  ),
});

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe('asking for a link', () => {
  it('answers an existing and an unknown address byte for byte alike (acceptance 1)', async () => {
    const { app, service, users } = await magicLinkApp();
    users.byEmail.set('ada@example.test', { id: 'usr_ada', status: 'active' });
    // From two fresh addresses, so even the rate limiter's headers match.
    const known = await requestLink(app, 'ada@example.test', { ip: '198.51.100.1' });
    const unknown = await requestLink(app, 'nobody@example.test', { ip: '198.51.100.2' });
    expect(comparable(known)).toEqual(comparable(unknown));
    expect(known.statusCode).toBe(202);
    await service.idle();
    // No account was looked up to answer either.
    expect(users.lookups).toBe(0);
  });

  it('answers JSON clients with the same page', async () => {
    const { app } = await magicLinkApp();
    const form = await requestLink(app, 'ada@example.test');
    const json = await app.inject({
      method: 'POST',
      url: '/login/email',
      remoteAddress: '203.0.113.7',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.test' },
    });
    expect(json.statusCode).toBe(202);
    expect(json.body).toBe(form.body);
  });

  it('answers within 50 ms of each other on average, existing or not (acceptance 1)', async () => {
    const { app, users } = await magicLinkApp();
    users.byEmail.set('ada@example.test', { id: 'usr_ada', status: 'active' });
    const time = async (email: string, ip: string): Promise<number> => {
      const started = performance.now();
      await requestLink(app, email, { ip });
      return performance.now() - started;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 15; i++) {
      known.push(await time('ada@example.test', `198.51.100.${i}`));
      unknown.push(await time(`nobody${i}@example.test`, `198.51.100.${100 + i}`));
    }
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(50);
  });

  it('mails every valid address, existing or new, and nothing for a malformed one', async () => {
    const { app, service, mailer, users } = await magicLinkApp();
    users.byEmail.set('ada@example.test', { id: 'usr_ada', status: 'active' });
    await requestLink(app, 'ada@example.test');
    await requestLink(app, 'new@example.test');
    const malformed = await requestLink(app, 'not an address');
    await service.idle();
    expect(mailer.sent.map((m) => m.to)).toEqual(['ada@example.test', 'new@example.test']);
    expect(malformed.statusCode).toBe(422);
    expect(malformed.headers['content-type']).toBe('text/html; charset=utf-8');
    const json = await app.inject({
      method: 'POST',
      url: '/login/email',
      headers: { 'content-type': 'application/json' },
      payload: { email: 42 },
    });
    expect(json.statusCode).toBe(422);
    expect(json.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: '/email' }],
    });
  });

  it('keeps an existing nonce cookie, so earlier links still work in the browser', async () => {
    const { app } = await magicLinkApp();
    const first = await requestLink(app, 'ada@example.test');
    const cookie = String(first.headers['set-cookie']).split(';')[0] ?? '';
    const second = await requestLink(app, 'ada@example.test', { cookie });
    expect(String(second.headers['set-cookie']).split(';')[0]).toBe(cookie);
    expect(String(first.headers['set-cookie'])).toMatch(
      /^centcom_login_nonce=[A-Za-z0-9_-]{43}; Path=\/login\/email; Max-Age=900; HttpOnly; SameSite=Lax; Secure$/,
    );
  });
});

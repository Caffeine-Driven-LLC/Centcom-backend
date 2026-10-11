/** The development mailer (B102): what it sends to Mailpit and how it fails. */
import { describe, expect, it } from 'vitest';
import { mailpitMailer } from '../../src/modules/auth/magic-link/dev-mailer.js';

describe('mailpitMailer (B102)', () => {
  it('posts the link, once, to Mailpit with the template copy', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const mailer = mailpitMailer({
      url: 'http://mail.test:8025/',
      from: 'Centcom <no-reply@centcom.test>',
      ttlS: 900,
      fetch: (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await mailer.send('ada@example.test', 'http://localhost:3000/login/email/verify?t=abc', 'en');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://mail.test:8025/api/v1/send');
    expect(calls[0]?.body).toMatchObject({
      To: [{ Email: 'ada@example.test' }],
      Subject: 'Your Centcom sign-in link',
    });
    expect(String(calls[0]?.body['Text'])).toContain(
      'http://localhost:3000/login/email/verify?t=abc',
    );
    expect(String(calls[0]?.body['Text'])).toContain('15 minutes');
  });

  it('throws without echoing the address or link when Mailpit refuses', async () => {
    const mailer = mailpitMailer({
      url: 'http://mail.test:8025',
      from: 'x@y.test',
      ttlS: 900,
      fetch: () => Promise.resolve(new Response('no', { status: 500 })),
    });
    const err = await mailer
      .send('ada@example.test', 'http://l/?t=secret', 'en')
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('ada@example.test');
    expect((err as Error).message).not.toContain('secret');
  });
});

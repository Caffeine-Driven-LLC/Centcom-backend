/**
 * Resend, Brevo and SMTP providers (production sign-in mail): the request each makes against a
 * local stand-in, the permanent/retryable split, timeouts, and that no key, password or recipient
 * reaches an error. The SMTP tests run a fake server in plain, STARTTLS and implicit-TLS modes
 * (TLS ones need `openssl` to make a throwaway certificate and are skipped without it).
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrevoProvider,
  buildMime,
  createEmailProvider,
  emailConfig,
  EmailProviderError,
  ResendProvider,
  Secret,
  SmtpProvider,
  splitSender,
  type RenderedEmail,
} from '../../src/index.js';
import { startFakeSmtp, tlsMaterial, type FakeSmtp } from './smtp-server.js';
import { captureLogger } from './helpers.js';

const EMAIL: RenderedEmail = {
  to: 'ada@example.test',
  from: 'Centcom <no-reply@centcom.test>',
  subject: 'Your Centcom sign-in link',
  html: '<p>Sign in: <a href="https://api.centcom.test/login?t=abc">link</a></p>',
  text: 'Sign in: https://api.centcom.test/login?t=abc\n.dot line',
  tag: 'magic_link',
};
const KEY = randomBytes(18).toString('hex');

interface Stub {
  url: string;
  requests: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function stub(answer: (res: ServerResponse) => void): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      answer(res);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const close = async (): Promise<void> => {
    for (const s of sockets) s.destroy();
    server.close();
    await once(server, 'close');
  };
  closers.push(close);
  return { url: `http://127.0.0.1:${port}`, requests, close };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (res: ServerResponse): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

async function failure(promise: Promise<unknown>): Promise<EmailProviderError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(EmailProviderError);
    return e as EmailProviderError;
  }
  throw new Error('expected an EmailProviderError');
}
const signal = (): AbortSignal => AbortSignal.timeout(5_000);

describe('ResendProvider', () => {
  const make = (url: string) => new ResendProvider({ apiKey: new Secret(KEY), baseUrl: url });

  it('posts to /emails with a bearer key and returns the id', async () => {
    const server = await stub(json(200, { id: 're_123' }));
    expect(await make(server.url).send(EMAIL, signal())).toEqual({ providerMessageId: 're_123' });
    const [req] = server.requests;
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/emails');
    expect(req?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      from: EMAIL.from,
      to: [EMAIL.to],
      subject: EMAIL.subject,
      html: EMAIL.html,
      text: EMAIL.text,
      tags: [{ name: 'template', value: 'magic_link' }],
    });
  });

  it.each([
    [401, false],
    [422, false],
    [429, true],
    [500, true],
  ])(
    'treats %d as retryable=%s without leaking the key or recipient',
    async (status, retryable) => {
      const server = await stub(
        json(status, { message: `bad ${EMAIL.to}` }, status === 429 ? { 'retry-after': '7' } : {}),
      );
      const error = await failure(make(server.url).send(EMAIL, signal()));
      expect(error).toMatchObject({ retryable, status });
      if (status === 429) expect(error.retryAfterMs).toBe(7000);
      for (const secret of [KEY, EMAIL.to, 'bad']) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    },
  );

  it('reports a reply without an id as malformed (retryable) and a dead port as network', async () => {
    const server = await stub(json(200, {}));
    expect(await failure(make(server.url).send(EMAIL, signal()))).toMatchObject({
      failure: 'malformed_reply',
      retryable: true,
    });
    await server.close();
    expect(await failure(make(server.url).send(EMAIL, signal()))).toMatchObject({
      failure: 'network',
      retryable: true,
    });
  });

  it('times out when the signal aborts', async () => {
    const server = await stub(() => undefined); // never answers
    const error = await failure(make(server.url).send(EMAIL, AbortSignal.timeout(150)));
    expect(error).toMatchObject({ failure: 'timeout', retryable: true });
  });
});

describe('BrevoProvider', () => {
  const make = (url: string) => new BrevoProvider({ apiKey: new Secret(KEY), baseUrl: url });

  it('posts to /v3/smtp/email with an api-key header, a split sender and the message id', async () => {
    const server = await stub(json(201, { messageId: '<202610@smtp-relay.brevo.com>' }));
    expect(await make(server.url).send(EMAIL, signal())).toEqual({
      providerMessageId: '<202610@smtp-relay.brevo.com>',
    });
    const [req] = server.requests;
    expect(req?.url).toBe('/v3/smtp/email');
    expect(req?.headers['api-key']).toBe(KEY);
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      sender: { email: 'no-reply@centcom.test', name: 'Centcom' },
      to: [{ email: EMAIL.to }],
      subject: EMAIL.subject,
      htmlContent: EMAIL.html,
      textContent: EMAIL.text,
      tags: ['magic_link'],
    });
  });

  it('sends a bare sender address without a name', async () => {
    const server = await stub(json(201, { messageId: 'm1' }));
    await make(server.url).send({ ...EMAIL, from: 'no-reply@centcom.test' }, signal());
    expect(JSON.parse(server.requests[0]?.body ?? '{}').sender).toEqual({
      email: 'no-reply@centcom.test',
    });
  });

  it.each([
    [400, false],
    [401, false],
    [429, true],
    [503, true],
  ])('treats %d as retryable=%s', async (status, retryable) => {
    const server = await stub(json(status, { code: 'x', message: EMAIL.to }));
    const error = await failure(make(server.url).send(EMAIL, signal()));
    expect(error).toMatchObject({ retryable, status });
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(error.message).not.toContain(EMAIL.to);
  });
});

describe('MIME and sender helpers', () => {
  it('splits sender lines', () => {
    expect(splitSender('Centcom <a@b.test>')).toEqual({ name: 'Centcom', address: 'a@b.test' });
    expect(splitSender('a@b.test')).toEqual({ name: undefined, address: 'a@b.test' });
  });

  it('builds a multipart message with base64 parts and encoded non-ASCII text', () => {
    const mime = buildMime(
      { ...EMAIL, from: 'Cénto <a@b.test>', subject: 'Zugang für Dich' },
      new Date('2026-10-13T10:00:00Z'),
      '<id@b.test>',
    );
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('From: =?UTF-8?B?');
    expect(mime).toContain('Date: Tue, 13 Oct 2026 10:00:00 +0000');
    expect(mime).toContain('Message-ID: <id@b.test>');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).not.toContain('Sign in:');
  });

  it('refuses a header value with a line break', () => {
    expect(() =>
      buildMime({ ...EMAIL, subject: 'x\r\nBcc: evil@x.test' }, new Date(), '<i@x.test>'),
    ).toThrow(EmailProviderError);
  });
});

/** The text of the first message's decoded parts. */
function decoded(data: string): { text: string; html: string; headers: string } {
  const parts = [
    ...data.matchAll(
      /Content-Type: (text\/\w+); charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g,
    ),
  ];
  const body = (type: string): string =>
    Buffer.from(
      (parts.find((p) => p[1] === type)?.[2] ?? '').replace(/\r\n/g, ''),
      'base64',
    ).toString('utf8');
  return {
    text: body('text/plain'),
    html: body('text/html'),
    headers: data.split('\r\n\r\n')[0] ?? '',
  };
}

describe('SmtpProvider', () => {
  const servers: FakeSmtp[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });
  const tls = tlsMaterial();
  const needsTls = tls === undefined;

  async function server(options: Parameters<typeof startFakeSmtp>[0]): Promise<FakeSmtp> {
    const s = await startFakeSmtp(options);
    servers.push(s);
    return s;
  }

  it('delivers over plain SMTP, with AUTH PLAIN, dot-stuffing and the full message', async () => {
    const smtp = await server({ mode: 'plain', auth: { user: 'u', password: 'p' } });
    const provider = new SmtpProvider({
      host: '127.0.0.1',
      port: smtp.port,
      secure: 'none',
      user: 'u',
      password: new Secret('p'),
    });
    const sent = await provider.send(EMAIL, signal());
    expect(sent.providerMessageId).toMatch(/^<[0-9a-f]{32}@centcom\.test>$/);
    expect(smtp.commands).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'END']);
    const [mail] = smtp.received;
    expect(mail).toMatchObject({
      mailFrom: 'no-reply@centcom.test',
      rcptTo: ['ada@example.test'],
      authenticated: true,
      encrypted: false,
    });
    const got = decoded(mail?.data ?? '');
    expect(got.text).toBe(EMAIL.text); // the ".dot line" survives dot-stuffing
    expect(got.html).toBe(EMAIL.html);
    expect(got.headers).toContain('Subject: Your Centcom sign-in link');
    expect(got.headers).toContain('To: ada@example.test');
    expect(got.headers).toContain(`Message-ID: ${sent.providerMessageId}`);
  });

  it.skipIf(needsTls)('upgrades with STARTTLS before sending credentials', async () => {
    const smtp = await server({ mode: 'starttls', auth: { user: 'u', password: 'p' } });
    const provider = new SmtpProvider({
      host: 'localhost',
      port: smtp.port,
      secure: 'starttls',
      user: 'u',
      password: new Secret('p'),
      tls: { ca: tls?.cert },
    });
    await provider.send(EMAIL, signal());
    expect(smtp.commands).toEqual([
      'EHLO',
      'STARTTLS',
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'DATA',
      'END',
    ]);
    expect(smtp.received[0]).toMatchObject({ encrypted: true, authenticated: true });
  });

  it.skipIf(needsTls)('delivers over implicit TLS', async () => {
    const smtp = await server({ mode: 'tls' });
    const provider = new SmtpProvider({
      host: 'localhost',
      port: smtp.port,
      secure: 'tls',
      tls: { ca: tls?.cert },
    });
    await provider.send(EMAIL, signal());
    expect(smtp.received[0]?.encrypted).toBe(true);
  });

  it.skipIf(needsTls)(
    'refuses to continue (and never sends credentials) when STARTTLS is not offered',
    async () => {
      const smtp = await server({ mode: 'starttls', offerStarttls: false });
      const provider = new SmtpProvider({
        host: 'localhost',
        port: smtp.port,
        secure: 'starttls',
        user: 'u',
        password: new Secret('p'),
        tls: { ca: tls?.cert },
      });
      expect(await failure(provider.send(EMAIL, signal()))).toMatchObject({ retryable: false });
      expect(smtp.commands).not.toContain('AUTH');
    },
  );

  it.skipIf(needsTls)('does not trust an unknown certificate', async () => {
    const smtp = await server({ mode: 'tls' });
    const provider = new SmtpProvider({ host: 'localhost', port: smtp.port, secure: 'tls' });
    expect(await failure(provider.send(EMAIL, signal()))).toMatchObject({ failure: 'network' });
    expect(smtp.received).toHaveLength(0);
  });

  it('maps a bad password to a permanent rejection without the password in the error', async () => {
    const smtp = await server({ mode: 'plain', auth: { user: 'u', password: 'right' } });
    const provider = new SmtpProvider({
      host: '127.0.0.1',
      port: smtp.port,
      secure: 'none',
      user: 'u',
      password: new Secret('wrong-password'),
    });
    const error = await failure(provider.send(EMAIL, signal()));
    expect(error).toMatchObject({ failure: 'rejected', retryable: false, status: 535 });
    expect(JSON.stringify(error) + error.message).not.toContain('wrong-password');
  });

  it.each([
    ['RCPT', '550 5.1.1 no such user', false],
    ['RCPT', '451 4.3.0 try later', true],
    ['MAIL', '421 4.7.0 busy', true],
    ['END', '554 5.7.1 spam', false],
  ] as const)('maps %s answering %s to retryable=%s', async (step, reply, retryable) => {
    const smtp = await server({ mode: 'plain', refuse: { [step]: reply } });
    const provider = new SmtpProvider({ host: '127.0.0.1', port: smtp.port, secure: 'none' });
    const error = await failure(provider.send(EMAIL, signal()));
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(Number(reply.slice(0, 3)));
    expect(error.message).not.toContain(EMAIL.to);
  });

  it('times out on a server that never greets, and reports a closed port as network', async () => {
    const smtp = await server({ mode: 'plain', silent: true });
    const slow = new SmtpProvider({ host: '127.0.0.1', port: smtp.port, secure: 'none' });
    expect(await failure(slow.send(EMAIL, AbortSignal.timeout(200)))).toMatchObject({
      failure: 'timeout',
      retryable: true,
    });
    const port = smtp.port;
    await smtp.close();
    servers.length = 0;
    const gone = new SmtpProvider({ host: '127.0.0.1', port, secure: 'none' });
    expect(await failure(gone.send(EMAIL, signal()))).toMatchObject({
      failure: 'network',
      retryable: true,
    });
  });

  it('refuses an injected header before opening a connection', async () => {
    const provider = new SmtpProvider({ host: '127.0.0.1', port: 1, secure: 'none' });
    const error = await failure(
      provider.send({ ...EMAIL, subject: 'a\r\nBcc: x@y.test' }, signal()),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailProviderError);
  });
});

describe('configuration of the new providers', () => {
  const FROM = 'Centcom <no-reply@centcom.test>';

  it('requires each provider’s own secret and builds it', () => {
    const logger = captureLogger().logger;
    const keys = (env: Record<string, string>): string[] => {
      try {
        emailConfig({ EMAIL_FROM: FROM, ...env });
      } catch (e) {
        return (e as { issues: { key: string }[] }).issues.map((i) => i.key);
      }
      return [];
    };
    expect(keys({ EMAIL_PROVIDER: 'resend' })).toEqual(['RESEND_API_KEY']);
    expect(keys({ EMAIL_PROVIDER: 'brevo' })).toEqual(['BREVO_API_KEY']);
    expect(keys({ EMAIL_PROVIDER: 'smtp' })).toEqual(['SMTP_HOST']);
    expect(keys({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'u' })).toEqual([
      'SMTP_PASSWORD',
    ]);
    const resend = emailConfig({ EMAIL_FROM: FROM, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY });
    expect(createEmailProvider(resend, logger).name).toBe('resend');
    const brevo = emailConfig({ EMAIL_FROM: FROM, EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: KEY });
    expect(createEmailProvider(brevo, logger).name).toBe('brevo');
    const smtp = emailConfig({
      EMAIL_FROM: FROM,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '465',
      SMTP_SECURE: 'tls',
      SMTP_USER: 'u',
      SMTP_PASSWORD: KEY,
    });
    expect(smtp.smtp).toMatchObject({
      host: 'smtp.example.test',
      port: 465,
      secure: 'tls',
      user: 'u',
    });
    expect(createEmailProvider(smtp, logger).name).toBe('smtp');
    expect(JSON.stringify(smtp)).not.toContain(KEY);
  });

  it('defaults SMTP to port 587 with required STARTTLS', () => {
    const c = emailConfig({ EMAIL_FROM: FROM, EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h' });
    expect(c.smtp).toEqual({ host: 'h', port: 587, secure: 'starttls' });
  });
});

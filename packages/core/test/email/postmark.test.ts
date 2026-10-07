/**
 * The Postmark provider (B032, card test email.postmark.test.ts) against a local HTTP stub of
 * Postmark's API: the request it makes, 200 (message id), 422 (permanent: never retried), 429 and
 * 500 (retryable, Retry-After honoured), a timeout (acceptance 5's abort), a closed port, and a
 * malformed reply. Errors never carry the token or the recipient.
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EmailProviderError,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  PostmarkProvider,
  Secret,
  type RenderedEmail,
} from '../../src/index.js';

const EMAIL: RenderedEmail = {
  to: 'ada@example.test',
  from: 'Centcom <no-reply@centcom.test>',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  tag: 'workspace_invite',
};

interface Stub {
  url: string;
  requests: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}

const servers: Stub[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** A Postmark stand-in answering every request with `answer`. */
async function stub(answer: (res: ServerResponse) => void): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      answer(res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const handle: Stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  servers.push(handle);
  return handle;
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (res: ServerResponse): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

/** The EmailProviderError `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<EmailProviderError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(EmailProviderError);
    return e as EmailProviderError;
  }
  throw new Error('expected an EmailProviderError');
}

const TOKEN = randomBytes(18).toString('hex');
const provider = (url: string): PostmarkProvider =>
  new PostmarkProvider({ token: new Secret(TOKEN), baseUrl: `${url}/` });

describe('PostmarkProvider', () => {
  it('posts the email to /email with the server token and no tracking, and returns the message id', async () => {
    const server = await stub(
      json(200, { MessageID: 'b7bc2f4a-e38e', ErrorCode: 0, Message: 'OK' }),
    );
    const sent = await provider(server.url).send(EMAIL, AbortSignal.timeout(5_000));
    expect(sent).toEqual({ providerMessageId: 'b7bc2f4a-e38e' });
    const [request] = server.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/email');
    expect(request?.headers['x-postmark-server-token']).toBe(TOKEN);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      From: EMAIL.from,
      To: EMAIL.to,
      Subject: EMAIL.subject,
      HtmlBody: EMAIL.html,
      TextBody: EMAIL.text,
      Tag: EMAIL.tag,
      MessageStream: 'outbound',
      TrackOpens: false,
      TrackLinks: 'None',
    });
  });

  it('reports a 422 as permanent, without the token, the recipient or Postmark’s text', async () => {
    const server = await stub(
      json(422, { ErrorCode: 300, Message: "Invalid 'To' address: 'ada@example.test'." }),
    );
    const error = await failure(provider(server.url).send(EMAIL, AbortSignal.timeout(5_000)));
    expect(error).toMatchObject({ failure: 'rejected', retryable: false, status: 422 });
    for (const secret of [TOKEN, EMAIL.to, 'Invalid']) {
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it.each([
    [401, false],
    [404, false],
    [429, true],
    [500, true],
    [503, true],
  ])('treats %d as retryable=%s', async (status, retryable) => {
    const server = await stub(json(status, { ErrorCode: 1 }));
    const error = await failure(provider(server.url).send(EMAIL, AbortSignal.timeout(5_000)));
    expect(error).toMatchObject({ retryable, status });
  });

  it('honours Retry-After on 429 and 5xx', async () => {
    const server = await stub(json(429, {}, { 'retry-after': '120' }));
    const error = await failure(provider(server.url).send(EMAIL, AbortSignal.timeout(5_000)));
    expect(error).toMatchObject({ failure: 'unavailable', retryable: true, retryAfterMs: 120_000 });
  });

  it('gives up when the signal times out (EMAIL_TIMEOUT_MS), as a retryable timeout', async () => {
    const server = await stub(() => undefined);
    const started = performance.now();
    const error = await failure(provider(server.url).send(EMAIL, AbortSignal.timeout(100)));
    expect(error).toMatchObject({ failure: 'timeout', retryable: true });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('reports an unreachable API as a retryable network error', async () => {
    const server = await stub(json(200, {}));
    const url = server.url;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const error = await failure(provider(url).send(EMAIL, AbortSignal.timeout(5_000)));
    expect(error).toMatchObject({ failure: 'network', retryable: true });
  });

  it('reports a 200 without a message id as a retryable malformed reply', async () => {
    for (const answer of [
      json(200, { ErrorCode: 0 }),
      (res: ServerResponse) => res.end('not json'),
    ]) {
      const server = await stub(answer);
      const error = await failure(provider(server.url).send(EMAIL, AbortSignal.timeout(5_000)));
      expect(error).toMatchObject({ failure: 'malformed_reply', retryable: true, status: 200 });
    }
  });

  it('uses the real API and the global fetch by default', () => {
    const real = new PostmarkProvider({ token: new Secret(TOKEN) });
    expect(real.name).toBe('postmark');
    expect(String(real)).not.toContain(TOKEN);
    expect(JSON.stringify(real)).not.toContain(TOKEN);
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.UTC(2026, 9, 7, 12);
  it.each([
    ['30', 30_000],
    [' 0 ', 0],
    ['999999999', MAX_RETRY_AFTER_MS],
    [new Date(NOW + 5_000).toUTCString(), 5_000],
  ])('reads %j as %d ms', (header, ms) => {
    expect(parseRetryAfter(header, NOW)).toBe(ms);
  });

  it.each([null, '', 'soon', '-5', new Date(NOW - 5_000).toUTCString()])('ignores %j', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeUndefined();
  });
});

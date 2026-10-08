/**
 * APNs (B064 acceptance 4 and 6) against a local HTTP/2 server: `POST /3/device/<token>` with the
 * topic, push type and priority, a provider token (ES256, team id and key id) that verifies with
 * the key's public half and is reused within 50 minutes, a body that is the CT-NOTIF-PAYLOAD
 * wrapped for the app (at most 3072 bytes), and the status mapping: 200 sent, 410 Unregistered and
 * 400 BadDeviceToken gone, 429/5xx retry, 403 and other 400s failed.
 */
import { createPublicKey, verify } from 'node:crypto';
import { connect, createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApnsProvider,
  APNS_TOKEN_TTL_MS,
} from '../../../src/modules/notifications/push/apns-provider.js';
import { loadPushConfig } from '../../../src/modules/notifications/push/config.js';
import {
  pushPayload,
  PUSH_BODY_MAX_BYTES,
} from '../../../src/modules/notifications/push/sender.js';
import { fullEnv, notification } from './helpers.js';

const TOKEN = 'a'.repeat(64);
let server: Http2Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  server = undefined;
});

/** A local h2c APNs answering `status` and `reason`, recording requests. */
async function apns(answer: () => { status: number; reason?: string }) {
  const requests: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks) });
      const { status, reason } = answer();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(reason === undefined ? '' : JSON.stringify({ reason }));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const env = fullEnv();
  const config = loadPushConfig(env);
  if (config.apns === undefined) throw new Error('no apns config');
  let now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const provider = new ApnsProvider({
    config: { ...config.apns, origin: `http://127.0.0.1:${port}` },
    connect: (origin) => connect(origin),
    clock: () => now,
  });
  return {
    provider,
    requests,
    publicKey: createPublicKey(env.apnsPublic),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const target = { id: 'psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W', kind: 'apns' as const, token: TOKEN };

describe('ApnsProvider', () => {
  it('sends the payload to /3/device/<token> with a verifiable provider token', async () => {
    const a = await apns(() => ({ status: 200 }));
    try {
      const payload = pushPayload({ ...notification() });
      expect(await a.provider.send(target, payload, { urgent: true })).toEqual({ result: 'sent' });
      const [request] = a.requests;
      expect(request?.headers).toMatchObject({
        ':method': 'POST',
        ':path': `/3/device/${TOKEN}`,
        'apns-topic': 'dev.centcom.app',
        'apns-push-type': 'alert',
        'apns-priority': '10',
      });
      const jwt = String(request?.headers['authorization']).replace(/^bearer /, '');
      const [h, p, s] = jwt.split('.') as [string, string, string];
      expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
        alg: 'ES256',
        kid: 'KEY1234567',
      });
      expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({
        iss: 'TEAM123456',
      });
      expect(
        verify(
          'sha256',
          Buffer.from(`${h}.${p}`),
          { key: a.publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(s, 'base64url'),
        ),
      ).toBe(true);
      expect(request?.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_BYTES);
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        aps: {
          alert: {
            'title-loc-key': 'notif.approval_needed.title',
            'loc-key': 'notif.approval_needed.body',
          },
          'mutable-content': 1,
        },
        n: JSON.parse(Buffer.from(payload).toString()),
      });
    } finally {
      a.provider.close();
    }
  });

  it('reuses its provider token for 50 minutes, then renews it', async () => {
    const a = await apns(() => ({ status: 200 }));
    try {
      const first = a.provider.providerToken();
      a.advance(APNS_TOKEN_TTL_MS - 1);
      expect(a.provider.providerToken()).toBe(first);
      a.advance(1_000);
      expect(a.provider.providerToken()).not.toBe(first);
    } finally {
      a.provider.close();
    }
  });

  it.each([
    [410, 'Unregistered', 'gone'],
    [400, 'BadDeviceToken', 'gone'],
    [400, 'DeviceTokenNotForTopic', 'failed'],
    [403, 'InvalidProviderToken', 'failed'],
    [429, 'TooManyRequests', 'retry'],
    [500, 'InternalServerError', 'retry'],
    [503, 'ServiceUnavailable', 'retry'],
  ] as const)('maps %i %s to %s', async (status, reason, result) => {
    const a = await apns(() => ({ status, reason }));
    try {
      expect(
        (
          await a.provider.send(target, Buffer.from(JSON.stringify(notification())), {
            urgent: false,
          })
        ).result,
      ).toBe(result);
      expect(a.requests[0]?.headers['apns-priority']).toBe('5');
    } finally {
      a.provider.close();
    }
  });

  it('retries when the server cannot be reached', async () => {
    const env = loadPushConfig(fullEnv());
    if (env.apns === undefined) throw new Error('no apns config');
    const provider = new ApnsProvider({ config: { ...env.apns, origin: 'http://127.0.0.1:1' } });
    expect(
      await provider.send(target, Buffer.from(JSON.stringify(notification())), { urgent: false }),
    ).toEqual({
      result: 'retry',
    });
    provider.close();
  });

  it('refuses a payload that is not JSON without sending', async () => {
    const a = await apns(() => ({ status: 200 }));
    try {
      expect(await a.provider.send(target, Buffer.from('not json'), { urgent: false })).toEqual({
        result: 'failed',
      });
      expect(a.requests).toEqual([]);
    } finally {
      a.provider.close();
    }
  });
});

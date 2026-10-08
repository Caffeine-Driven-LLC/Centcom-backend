/**
 * FCM (B064 acceptance 4 and 6) against stubbed endpoints: an RS256 assertion for the service
 * account that verifies with its public key, exchanged once for an access token that is reused
 * until it expires (and dropped on a 401), `messages:send` with the payload as the data field `n`
 * (at most 3072 bytes), and the outcome mapping: 200 sent, UNREGISTERED or 404 gone, 429/5xx and
 * network errors retry, 400 INVALID_ARGUMENT and 403 failed, no access token failed.
 */
import { createPublicKey, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadPushConfig } from '../../../src/modules/notifications/push/config.js';
import { FcmProvider, FCM_SCOPE } from '../../../src/modules/notifications/push/fcm-provider.js';
import {
  pushPayload,
  PUSH_BODY_MAX_BYTES,
} from '../../../src/modules/notifications/push/sender.js';
import { fullEnv, notification } from './helpers.js';

const target = {
  id: 'psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  kind: 'fcm' as const,
  token: 'fcm:token-123_abc',
};

function fcm(send: () => { status: number; body?: unknown } | 'throw', tokenStatus = 200) {
  const env = fullEnv();
  const config = loadPushConfig(env);
  if (config.fcm === undefined) throw new Error('no fcm config');
  const calls: { url: string; init: RequestInit }[] = [];
  let now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const provider = new FcmProvider({
    config: config.fcm,
    clock: () => now,
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === config.fcm?.tokenUri) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: `at-${calls.length}`, expires_in: 3600 }), {
            status: tokenStatus,
          }),
        );
      }
      const answer = send();
      if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(
        new Response(answer.body === undefined ? '{}' : JSON.stringify(answer.body), {
          status: answer.status,
        }),
      );
    },
  });
  return {
    provider,
    calls,
    config: config.fcm,
    publicKey: createPublicKey(env.fcmPublic),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('FcmProvider', () => {
  it('exchanges a verifiable assertion and sends the payload as data', async () => {
    const f = fcm(() => ({ status: 200, body: { name: 'projects/x/messages/1' } }));
    const payload = pushPayload({ ...notification() });
    expect(await f.provider.send(target, payload, { urgent: true })).toEqual({ result: 'sent' });
    const [token, send] = f.calls;
    const form = new URLSearchParams(String(token?.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, s] = String(form.get('assertion')).split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({
      iss: 'push@centcom-test.iam.gserviceaccount.com',
      scope: FCM_SCOPE,
      aud: 'https://oauth2.example.test/token',
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${p}`)
        .verify(f.publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
    expect(send?.url).toBe('https://fcm.googleapis.com/v1/projects/centcom-test/messages:send');
    expect((send?.init.headers as Record<string, string>)['authorization']).toBe('Bearer at-1');
    const body = String(send?.init.body);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PUSH_BODY_MAX_BYTES);
    expect(JSON.parse(body)).toEqual({
      message: {
        token: target.token,
        data: { n: Buffer.from(payload).toString() },
        android: { priority: 'high' },
      },
    });
  });

  it('reuses the access token until a minute before it expires, and drops it on a 401', async () => {
    let status = 200;
    const f = fcm(() => ({ status }));
    await f.provider.send(target, Buffer.from('{}'), { urgent: false });
    await f.provider.send(target, Buffer.from('{}'), { urgent: false });
    expect(f.calls.filter((c) => c.url === f.config.tokenUri)).toHaveLength(1);
    f.advance(3_541_000);
    await f.provider.send(target, Buffer.from('{}'), { urgent: false });
    expect(f.calls.filter((c) => c.url === f.config.tokenUri)).toHaveLength(2);
    status = 401;
    expect((await f.provider.send(target, Buffer.from('{}'), { urgent: false })).result).toBe(
      'failed',
    );
    status = 200;
    await f.provider.send(target, Buffer.from('{}'), { urgent: false });
    expect(f.calls.filter((c) => c.url === f.config.tokenUri)).toHaveLength(3);
  });

  it.each([
    [{ status: 404, body: { error: { status: 'NOT_FOUND' } } }, 'gone'],
    [
      {
        status: 400,
        body: { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } },
      },
      'gone',
    ],
    [
      {
        status: 400,
        body: {
          error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] },
        },
      },
      'failed',
    ],
    [{ status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }, 'failed'],
    [{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }, 'retry'],
    [{ status: 503, body: { error: { status: 'UNAVAILABLE' } } }, 'retry'],
  ] as const)('maps %j to %s', async (answer, result) => {
    const f = fcm(() => answer);
    expect((await f.provider.send(target, Buffer.from('{}'), { urgent: false })).result).toBe(
      result,
    );
  });

  it('retries a network error, and fails without an access token', async () => {
    expect(
      (await fcm(() => 'throw').provider.send(target, Buffer.from('{}'), { urgent: false })).result,
    ).toBe('retry');
    const noToken = fcm(() => ({ status: 200 }), 401);
    expect((await noToken.provider.send(target, Buffer.from('{}'), { urgent: false })).result).toBe(
      'failed',
    );
    expect(noToken.calls.some((c) => c.url.includes('messages:send'))).toBe(false);
  });
});

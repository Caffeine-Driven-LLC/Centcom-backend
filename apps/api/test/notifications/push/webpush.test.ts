/**
 * Web push (B064 acceptance 4 and 6): RFC 8291's test vector byte for byte, a VAPID header whose
 * ES256 JWT verifies with the public key, and the provider's requests: aes128gcm body that the
 * browser decrypts to valid CT-NOTIF-PAYLOAD JSON (at most 3072 bytes sent), TTL and urgency, no
 * redirects followed, status mapping (201 sent, 404/410 gone, 429/5xx/timeout retry, 403 failed),
 * and the send-time SSRF check refusing an endpoint that resolves to a private address.
 */
import { createPublicKey, verify } from 'node:crypto';
import { validateNotification } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { vapidKeys } from '../../../src/modules/notifications/push/config.js';
import {
  pushPayload,
  PUSH_BODY_MAX_BYTES,
} from '../../../src/modules/notifications/push/sender.js';
import {
  encryptAes128gcm,
  vapidAuthorization,
  WebPushProvider,
} from '../../../src/modules/notifications/push/webpush-provider.js';
import { decryptAes128gcm, notification, vapidPair, webTarget } from './helpers.js';

const b = (s: string): Buffer => Buffer.from(s, 'base64url');

describe('RFC 8291 encryption', () => {
  it('reproduces the RFC 8291 section 5 example', () => {
    const body = encryptAes128gcm(
      b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      b('BTBZMqHH6r4Tts7J_aSIgg'),
      {
        salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
        serverPrivateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    expect(
      decryptAes128gcm(
        body,
        b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
        b('BTBZMqHH6r4Tts7J_aSIgg'),
      ).toString(),
    ).toBe('When I grow up, I want to be a watermelon');
  });
});

describe('VAPID', () => {
  it('signs an ES256 JWT for the endpoint origin that verifies with the public key', () => {
    const pair = vapidPair();
    const vapid = {
      ...vapidKeys(pair.publicKey, pair.privateKey),
      subject: 'mailto:ops@centcom.test',
    };
    const header = vapidAuthorization(
      'https://push.example.com/send/abc?x=1',
      vapid,
      1_800_000_000,
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m?.[2]).toBe(pair.publicKey);
    const [h, p, s] = (m?.[1] ?? '').split('.') as [string, string, string];
    expect(JSON.parse(b(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b(p).toString())).toEqual({
      aud: 'https://push.example.com',
      exp: 1_800_000_000 + 12 * 3600,
      sub: 'mailto:ops@centcom.test',
    });
    const pub = b(pair.publicKey);
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b(s)),
    ).toBe(true);
  });
});

describe('WebPushProvider', () => {
  function provider(status: number | 'throw', resolveTo = ['93.184.216.34']) {
    const pair = vapidPair();
    const requests: { url: string; init: RequestInit }[] = [];
    const web = new WebPushProvider({
      vapid: { ...vapidKeys(pair.publicKey, pair.privateKey), subject: 'mailto:ops@centcom.test' },
      resolve: () => Promise.resolve(resolveTo),
      fetch: (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (status === 'throw')
          return Promise.reject(new DOMException('timed out', 'TimeoutError'));
        return Promise.resolve(new Response(null, { status }));
      },
    });
    return { web, requests };
  }

  it('posts an aes128gcm body the browser decrypts to the payload, within 3072 bytes', async () => {
    const { web, requests } = provider(201);
    const { target, privateKey, auth } = webTarget();
    const payload = pushPayload({ ...notification() });
    expect(await web.send(target, payload, { urgent: true })).toEqual({ result: 'sent' });
    const [request] = requests;
    expect(request?.url).toBe(target.token);
    expect(request?.init.redirect).toBe('manual');
    const headers = request?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
    });
    expect(headers['authorization']).toMatch(/^vapid t=.+, k=.+$/);
    const body = request?.init.body as Buffer;
    expect(body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_BYTES);
    const plain = decryptAes128gcm(body, privateKey, auth);
    const decoded = JSON.parse(plain.toString()) as unknown;
    expect(decoded).toEqual(JSON.parse(Buffer.from(payload).toString()));
    expect(validateNotification(decoded).ok).toBe(true);
  });

  it.each([
    [201, 'sent'],
    [202, 'sent'],
    [404, 'gone'],
    [410, 'gone'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
    [400, 'failed'],
    [403, 'failed'],
    [301, 'failed'],
  ] as const)('maps %i to %s', async (status, result) => {
    const { web } = provider(status);
    expect((await web.send(webTarget().target, Buffer.from('{}'), { urgent: false })).result).toBe(
      result,
    );
  });

  it('retries a timeout or network error', async () => {
    const { web } = provider('throw');
    expect(await web.send(webTarget().target, Buffer.from('{}'), { urgent: false })).toEqual({
      result: 'retry',
    });
  });

  it.each([['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['fd00::1']])(
    'refuses an endpoint that resolves to %s, sending nothing',
    async (address) => {
      const { web, requests } = provider(201, ['93.184.216.34', address]);
      expect(await web.send(webTarget().target, Buffer.from('{}'), { urgent: false })).toEqual({
        result: 'failed',
      });
      expect(requests).toEqual([]);
    },
  );

  it('refuses a target without keys, and treats unusable keys as gone', async () => {
    const { web } = provider(201);
    const { target } = webTarget();
    const bare = { id: target.id, kind: target.kind, token: target.token };
    expect(await web.send(bare, Buffer.from('{}'), { urgent: false })).toEqual({
      result: 'failed',
    });
    expect(
      await web.send(
        { ...target, keys: { p256dh: 'AAAA', auth: target.keys.auth } },
        Buffer.from('{}'),
        { urgent: false },
      ),
    ).toEqual({ result: 'gone' });
  });
});

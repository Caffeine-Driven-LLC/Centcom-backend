/**
 * Test helpers for push (B064): keys generated in the test (VAPID P-256, an APNs P-256 .p8, an
 * FCM RSA service account), a browser subscription with its private key so tests can decrypt what
 * was sent (RFC 8291), CT-NOTIF-PAYLOAD objects, an in-memory registry with the Postgres one's
 * delivery bookkeeping, and providers that answer from a script and record concurrency.
 */
import {
  createDecipheriv,
  createECDH,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { Secret, type Env } from '@centcom/core';
import type { NotificationPayload } from '../../../src/modules/notifications/dispatcher/ports.js';
import type {
  PushKind,
  PushProvider,
  PushTarget,
  SendOutcome,
} from '../../../src/modules/notifications/push/providers.js';

/** A fresh VAPID key pair: public (65 bytes) and private (32 bytes), base64url. */
export function vapidPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey drops leading zero bytes: pad back to the 32 bytes VAPID keys have.
  const d = Buffer.alloc(32);
  const raw = ecdh.getPrivateKey();
  raw.copy(d, 32 - raw.length);
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: d.toString('base64url'),
  };
}

/** A P-256 key as the PEM an APNs .p8 file holds, with its public half. */
export function apnsKey() {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

/** An FCM service account JSON with its public key. */
export function serviceAccount(tokenUri = 'https://oauth2.example.test/token') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    json: JSON.stringify({
      type: 'service_account',
      project_id: 'centcom-test',
      client_email: 'push@centcom-test.iam.gserviceaccount.com',
      private_key: privateKey,
      token_uri: tokenUri,
    }),
    publicKey,
  };
}

/** A push encryption key (32 bytes). */
export const pushKey = (): Secret<Uint8Array> => new Secret(new Uint8Array(randomBytes(32)));

/** A configuration with every provider on. */
export function fullEnv(): Env & { apnsPublic: string; fcmPublic: string; vapidPublic: string } {
  const vapid = vapidPair();
  const apns = apnsKey();
  const fcm = serviceAccount();
  return {
    PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
    PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
    PUSH_VAPID_SUBJECT: 'mailto:ops@centcom.test',
    PUSH_APNS_TEAM_ID: 'TEAM123456',
    PUSH_APNS_KEY_ID: 'KEY1234567',
    PUSH_APNS_PRIVATE_KEY: apns.privateKey,
    PUSH_APNS_TOPIC: 'dev.centcom.app',
    PUSH_FCM_SERVICE_ACCOUNT: fcm.json,
    apnsPublic: apns.publicKey,
    fcmPublic: fcm.publicKey,
    vapidPublic: vapid.publicKey,
  };
}

/** A browser's push subscription keys, with its private key to decrypt what it receives. */
export function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    privateKey: ecdh.getPrivateKey(),
  };
}

/** Decrypts an RFC 8291 `aes128gcm` body as the browser would. */
export function decryptAes128gcm(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // Strip the padding delimiter (0x02) and any zero padding after it.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end -= 1;
  return record.subarray(0, end);
}

/** A CT-NOTIF-PAYLOAD for `approval_needed`, with `overrides`. */
export function notification(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    id: 'ntf_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    created_at: '2026-10-08T12:00:00.000Z',
    read_at: null,
    category: 'approval_needed',
    title_key: 'notif.approval_needed.title',
    body_key: 'notif.approval_needed.body',
    params: {
      agent: 'agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      session: 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      risk: 'high',
    },
    action: { type: 'open_session', deeplink: 'centcom://s/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W' },
    priority: 'high',
    ...overrides,
  };
}

/** An in-memory registry with the delivery bookkeeping of the Postgres one. */
export function memoryRegistry(targets: PushTarget[]) {
  const live = new Map(targets.map((t) => [t.id, t]));
  const failures = new Map<string, number>();
  const calls = { success: [] as string[], failure: [] as string[], deleted: [] as string[] };
  return {
    live,
    calls,
    targets: (_userId: string, ids?: readonly string[]) =>
      Promise.resolve([...live.values()].filter((t) => ids === undefined || ids.includes(t.id))),
    recordSuccess: (id: string) => {
      calls.success.push(id);
      failures.delete(id);
      return Promise.resolve();
    },
    recordFailure: (id: string) => {
      calls.failure.push(id);
      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);
      if (n >= 5) {
        live.delete(id);
        calls.deleted.push(id);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    delete: (id: string) => {
      live.delete(id);
      calls.deleted.push(id);
      return Promise.resolve();
    },
  };
}

/** A provider answering from `script` (per call, last answer repeats), recording sends and concurrency. */
export function scriptedProvider(
  kind: PushKind,
  script: SendOutcome['result'][] = ['sent'],
  delayMs = 0,
) {
  const sent: { target: PushTarget; payload: Buffer }[] = [];
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const provider: PushProvider & { sent: typeof sent; peak(): number } = {
    kind,
    sent,
    peak: () => peak,
    async send(target, payload) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        sent.push({ target, payload: Buffer.from(payload) });
        const result = script[Math.min(calls, script.length - 1)] ?? 'sent';
        calls += 1;
        return { result } as SendOutcome;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return provider;
}

/** A web-push target with fresh keys at a public-looking endpoint. */
export function webTarget(id = 'psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W') {
  const keys = browserKeys();
  return {
    target: {
      id,
      kind: 'web_push' as const,
      token: `https://push.example.com/send/${randomBytes(8).toString('hex')}`,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
    privateKey: keys.privateKey,
    auth: Buffer.from(keys.auth, 'base64url'),
  };
}

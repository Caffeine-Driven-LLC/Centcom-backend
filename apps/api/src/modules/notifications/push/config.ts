/**
 * Push configuration (B064), read through the config loader (B004) from secrets, never from the
 * repository:
 *
 * - `PUSH_ENCRYPTION_KEY` (required, 32 bytes base64): seals endpoints, tokens and web-push keys
 *   at rest.
 * - Web push: `PUSH_VAPID_PUBLIC_KEY` (65-byte uncompressed P-256, base64url),
 *   `PUSH_VAPID_PRIVATE_KEY` (32 bytes, base64url), `PUSH_VAPID_SUBJECT` (`mailto:` or https).
 * - APNs: `PUSH_APNS_TEAM_ID`, `PUSH_APNS_KEY_ID`, `PUSH_APNS_PRIVATE_KEY` (the .p8 PEM),
 *   `PUSH_APNS_TOPIC` (bundle id), `PUSH_APNS_ORIGIN` (default https://api.push.apple.com).
 * - FCM: `PUSH_FCM_SERVICE_ACCOUNT` (the service account JSON), `PUSH_FCM_ORIGIN` (default
 *   https://fcm.googleapis.com).
 * - `PUSH_CONCURRENCY_PER_PROVIDER` (default 20).
 *
 * A provider whose keys are all absent is off (its subscriptions are kept and skipped). One whose
 * keys are partly set, or set but unusable (a VAPID private key that does not match its public
 * key, a PEM that is not an EC P-256 key, a service account without its fields), is a
 * ConfigError: the API refuses to start.
 *
 * Owns: reading and checking these keys. Must not: put a key in an error or a log.
 */
import { createECDH, createPrivateKey, type KeyObject } from 'node:crypto';
import {
  ConfigError,
  defineConfig,
  envInt,
  envUrl,
  Secret,
  secretString,
  z,
  type Env,
} from '@centcom/core';

/** Default per-provider concurrency. */
export const DEFAULT_PUSH_CONCURRENCY = 20;

const B64URL = /^[A-Za-z0-9_-]+$/;

/** The environment keys of push. */
export const pushEnvSchema = z.object({
  PUSH_ENCRYPTION_KEY: secretString().meta({
    description: 'AES-256 key (32 bytes, base64) sealing push endpoints, tokens and keys at rest.',
    example: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }),
  PUSH_VAPID_PUBLIC_KEY: z.string().optional().meta({
    description: 'VAPID public key: uncompressed P-256 point (65 bytes), base64url.',
  }),
  PUSH_VAPID_PRIVATE_KEY: secretString().optional().meta({
    description: 'VAPID private key (32 bytes), base64url.',
  }),
  PUSH_VAPID_SUBJECT: z.string().optional().meta({
    description: 'VAPID subject: a mailto: address or an https URL.',
    example: 'mailto:ops@centcom.dev',
  }),
  PUSH_APNS_TEAM_ID: z.string().optional().meta({ description: 'Apple developer team id.' }),
  PUSH_APNS_KEY_ID: z.string().optional().meta({ description: 'APNs auth key id.' }),
  PUSH_APNS_PRIVATE_KEY: secretString().optional().meta({
    description: 'APNs auth key (.p8, PEM).',
  }),
  PUSH_APNS_TOPIC: z.string().optional().meta({ description: 'The app bundle id (apns-topic).' }),
  PUSH_APNS_ORIGIN: envUrl({ protocols: ['https:', 'http:'], plain: true })
    .default('https://api.push.apple.com')
    .meta({ description: 'APNs origin (HTTP/2).' }),
  PUSH_FCM_SERVICE_ACCOUNT: secretString().optional().meta({
    description: 'FCM service account JSON (project_id, client_email, private_key, token_uri).',
  }),
  PUSH_FCM_ORIGIN: envUrl({ protocols: ['https:', 'http:'], plain: true })
    .default('https://fcm.googleapis.com')
    .meta({ description: 'FCM HTTP v1 origin.' }),
  PUSH_CONCURRENCY_PER_PROVIDER: envInt({ min: 1, max: 1000 })
    .default(DEFAULT_PUSH_CONCURRENCY)
    .meta({ description: 'Sends in flight per provider, at most.' }),
});

/** Web push (VAPID, RFC 8292). */
export interface VapidConfig {
  /** base64url, 65 bytes. */
  publicKey: string;
  privateKey: KeyObject;
  subject: string;
}

/** APNs token authentication. */
export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: KeyObject;
  topic: string;
  origin: string;
}

/** FCM HTTP v1 with a service account. */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: KeyObject;
  tokenUri: string;
  origin: string;
}

/** Checked push settings; a provider is absent when it is off. */
export interface PushConfig {
  encryptionKey: Secret<Uint8Array>;
  vapid?: VapidConfig;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
  concurrency: number;
}

const problem = (key: string, text: string): ConfigError =>
  new ConfigError([{ key, problem: text }]);

/** All or none of `values` set; throws naming the first missing key. */
function group(values: Record<string, unknown>): boolean {
  const set = Object.entries(values).filter(([, v]) => v !== undefined);
  if (set.length === 0) return false;
  const missing = Object.keys(values).find((k) => values[k] === undefined);
  if (missing !== undefined)
    throw problem(missing, 'is required when the other keys of its provider are set');
  return true;
}

/** The VAPID pair, checked: the private key must produce the public one. */
export function vapidKeys(
  publicB64: string,
  privateB64: string,
): { publicKey: string; privateKey: KeyObject } {
  const pub = B64URL.test(publicB64) ? Buffer.from(publicB64, 'base64url') : Buffer.alloc(0);
  if (pub.length !== 65 || pub[0] !== 4) {
    throw problem(
      'PUSH_VAPID_PUBLIC_KEY',
      'must be an uncompressed P-256 point (65 bytes), base64url',
    );
  }
  const d = B64URL.test(privateB64) ? Buffer.from(privateB64, 'base64url') : Buffer.alloc(0);
  if (d.length !== 32) throw problem('PUSH_VAPID_PRIVATE_KEY', 'must be 32 bytes, base64url');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: d.toString('base64url'),
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    throw problem('PUSH_VAPID_PRIVATE_KEY', 'is not a P-256 private key for the public key');
  }
  // A JWK's x and y are taken as given: derive the public key from d to know the pair is one.
  let derived: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    derived = ecdh.getPublicKey();
  } catch {
    throw problem('PUSH_VAPID_PRIVATE_KEY', 'is not a P-256 private key');
  }
  if (!derived.equals(pub)) {
    throw problem('PUSH_VAPID_PRIVATE_KEY', 'does not match PUSH_VAPID_PUBLIC_KEY');
  }
  return { publicKey: publicB64, privateKey };
}

function ecKey(key: string, pem: string): KeyObject {
  try {
    const k = createPrivateKey(pem);
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error('curve');
    return k;
  } catch {
    throw problem(key, 'must be an EC P-256 private key (PEM)');
  }
}

function serviceAccount(json: string, origin: string): FcmConfig {
  const fail = () =>
    problem(
      'PUSH_FCM_SERVICE_ACCOUNT',
      'must be a service account JSON with project_id, client_email and private_key',
    );
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw fail();
  }
  const {
    project_id: projectId,
    client_email: clientEmail,
    private_key: pem,
    token_uri: tokenUri,
  } = parsed;
  if (typeof projectId !== 'string' || typeof clientEmail !== 'string' || typeof pem !== 'string')
    throw fail();
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('rsa');
  } catch {
    throw fail();
  }
  return {
    projectId,
    clientEmail,
    privateKey,
    tokenUri: typeof tokenUri === 'string' ? tokenUri : 'https://oauth2.googleapis.com/token',
    origin,
  };
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadPushConfig(env?: Env): PushConfig {
  const v = defineConfig(pushEnvSchema, env);
  const raw = v.PUSH_ENCRYPTION_KEY.reveal();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw problem('PUSH_ENCRYPTION_KEY', 'must be 32 bytes, base64');
  }
  const config: PushConfig = {
    encryptionKey: new Secret(new Uint8Array(key)),
    concurrency: v.PUSH_CONCURRENCY_PER_PROVIDER,
  };
  if (
    group({
      PUSH_VAPID_PUBLIC_KEY: v.PUSH_VAPID_PUBLIC_KEY,
      PUSH_VAPID_PRIVATE_KEY: v.PUSH_VAPID_PRIVATE_KEY,
      PUSH_VAPID_SUBJECT: v.PUSH_VAPID_SUBJECT,
    })
  ) {
    const subject = v.PUSH_VAPID_SUBJECT ?? '';
    if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/\S+$/.test(subject)) {
      throw problem('PUSH_VAPID_SUBJECT', 'must be a mailto: address or an https URL');
    }
    config.vapid = {
      ...vapidKeys(v.PUSH_VAPID_PUBLIC_KEY ?? '', v.PUSH_VAPID_PRIVATE_KEY?.reveal() ?? ''),
      subject,
    };
  }
  if (
    group({
      PUSH_APNS_TEAM_ID: v.PUSH_APNS_TEAM_ID,
      PUSH_APNS_KEY_ID: v.PUSH_APNS_KEY_ID,
      PUSH_APNS_PRIVATE_KEY: v.PUSH_APNS_PRIVATE_KEY,
      PUSH_APNS_TOPIC: v.PUSH_APNS_TOPIC,
    })
  ) {
    config.apns = {
      teamId: v.PUSH_APNS_TEAM_ID ?? '',
      keyId: v.PUSH_APNS_KEY_ID ?? '',
      privateKey: ecKey('PUSH_APNS_PRIVATE_KEY', v.PUSH_APNS_PRIVATE_KEY?.reveal() ?? ''),
      topic: v.PUSH_APNS_TOPIC ?? '',
      origin: v.PUSH_APNS_ORIGIN,
    };
  }
  if (v.PUSH_FCM_SERVICE_ACCOUNT !== undefined) {
    config.fcm = serviceAccount(v.PUSH_FCM_SERVICE_ACCOUNT.reveal(), v.PUSH_FCM_ORIGIN);
  }
  return config;
}

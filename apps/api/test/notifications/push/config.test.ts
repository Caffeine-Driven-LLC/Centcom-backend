/**
 * Push configuration (B064 failure mode "invalid credentials fail fast at startup"): every
 * provider on, providers off when their keys are absent, and a ConfigError naming the key (never
 * its value) for a missing or malformed encryption key, a partly set provider, a VAPID private key
 * that does not match its public key, an APNs key that is not P-256, an FCM service account that
 * is not one, and a bad VAPID subject.
 */
import { randomBytes } from 'node:crypto';
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_CONCURRENCY,
  loadPushConfig,
} from '../../../src/modules/notifications/push/config.js';
import { fullEnv, vapidPair } from './helpers.js';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('no ConfigError');
}

describe('loadPushConfig', () => {
  it('turns every provider on when its keys are set', () => {
    const config = loadPushConfig(fullEnv());
    expect(config.vapid?.subject).toBe('mailto:ops@centcom.test');
    expect(config.apns).toMatchObject({
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      topic: 'dev.centcom.app',
    });
    expect(config.apns?.origin).toBe('https://api.push.apple.com');
    expect(config.fcm).toMatchObject({
      projectId: 'centcom-test',
      origin: 'https://fcm.googleapis.com',
    });
    expect(config.concurrency).toBe(DEFAULT_PUSH_CONCURRENCY);
    expect(config.encryptionKey.reveal()).toHaveLength(32);
  });

  it('leaves a provider off when none of its keys is set', () => {
    const config = loadPushConfig({ PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(config.vapid).toBeUndefined();
    expect(config.apns).toBeUndefined();
    expect(config.fcm).toBeUndefined();
  });

  it.each<[string, (env: Record<string, string | undefined>) => void, string]>([
    ['no encryption key', (e) => delete e['PUSH_ENCRYPTION_KEY'], 'PUSH_ENCRYPTION_KEY'],
    [
      'a short encryption key',
      (e) => (e['PUSH_ENCRYPTION_KEY'] = randomBytes(16).toString('base64')),
      'PUSH_ENCRYPTION_KEY',
    ],
    ['a VAPID subject missing', (e) => delete e['PUSH_VAPID_SUBJECT'], 'PUSH_VAPID_SUBJECT'],
    [
      'a VAPID subject that is not mailto or https',
      (e) => (e['PUSH_VAPID_SUBJECT'] = 'ops@centcom.test'),
      'PUSH_VAPID_SUBJECT',
    ],
    [
      'a VAPID private key of another pair',
      (e) => (e['PUSH_VAPID_PRIVATE_KEY'] = vapidPair().privateKey),
      'PUSH_VAPID_PRIVATE_KEY',
    ],
    [
      'a short VAPID public key',
      (e) => (e['PUSH_VAPID_PUBLIC_KEY'] = 'BAAA'),
      'PUSH_VAPID_PUBLIC_KEY',
    ],
    [
      'a short VAPID private key',
      (e) => (e['PUSH_VAPID_PRIVATE_KEY'] = 'AAAA'),
      'PUSH_VAPID_PRIVATE_KEY',
    ],
    ['an APNs topic missing', (e) => delete e['PUSH_APNS_TOPIC'], 'PUSH_APNS_TOPIC'],
    [
      'an APNs key that is not PEM',
      (e) => (e['PUSH_APNS_PRIVATE_KEY'] = 'not a key'),
      'PUSH_APNS_PRIVATE_KEY',
    ],
    [
      'an FCM service account that is not JSON',
      (e) => (e['PUSH_FCM_SERVICE_ACCOUNT'] = '{oops'),
      'PUSH_FCM_SERVICE_ACCOUNT',
    ],
    [
      'an FCM service account without its key',
      (e) => (e['PUSH_FCM_SERVICE_ACCOUNT'] = '{"project_id":"x","client_email":"y"}'),
      'PUSH_FCM_SERVICE_ACCOUNT',
    ],
  ])('refuses to start with %s', (_case, change, key) => {
    const env: Record<string, string | undefined> = { ...fullEnv() };
    change(env);
    const error = configError(() => loadPushConfig(env));
    expect(error.issues.map((i) => i.key)).toEqual([key]);
    for (const value of Object.values(fullEnv())) {
      if (typeof value === 'string' && value.length > 20)
        expect(error.message).not.toContain(value);
    }
  });

  it('refuses an APNs key on another curve and an FCM key that is not RSA', () => {
    const env = fullEnv();
    const fcm = JSON.parse(env['PUSH_FCM_SERVICE_ACCOUNT'] ?? '{}') as Record<string, string>;
    const apnsAsRsa = { ...env, PUSH_APNS_PRIVATE_KEY: fcm['private_key'] };
    expect(configError(() => loadPushConfig(apnsAsRsa)).issues[0]?.key).toBe(
      'PUSH_APNS_PRIVATE_KEY',
    );
    const fcmAsEc = {
      ...env,
      PUSH_FCM_SERVICE_ACCOUNT: JSON.stringify({
        ...fcm,
        private_key: env['PUSH_APNS_PRIVATE_KEY'],
      }),
    };
    expect(configError(() => loadPushConfig(fcmAsEc)).issues[0]?.key).toBe(
      'PUSH_FCM_SERVICE_ACCOUNT',
    );
  });
});

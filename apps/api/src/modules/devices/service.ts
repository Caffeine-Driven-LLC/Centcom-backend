/**
 * Device registry (B020, CT-API-ACCOUNTS and CT-AUTH): a user's devices, their public keys for
 * session peers, and revocation.
 *
 * - `registerDevice` checks the keys (32 bytes, canonical base64url, not all zero), the name and
 *   the platform, computes the CT-CRYPTO fingerprint and inserts the device. Keys never change
 *   afterwards (trust on first use): a new key is a new device.
 * - `touchDevice` writes `last_seen_at` at most once per 5 minutes per device: a bounded
 *   in-process memory skips most calls, and the conditional update holds across instances.
 * - Reads: a user sees only their own devices; anyone else's id is a 404, never a 403. Public keys
 *   go to the owner and to users who share a session with them, revoked devices included (with
 *   `revoked: true`), so old history still verifies.
 * - `revokeDevice` sets `revoked_at` once (the call that did it announces it), then publishes
 *   `{device, user}` on `devices:revoked` (retried in the background when Redis fails: at least
 *   once), has the token service kill the device's tokens (B017: refresh families revoked, access
 *   tokens `device_revoked`), and queues the `auth.device_revoked` audit event, whose failure is
 *   logged and retried by the emitter and never blocks. Revoking again does the token step again
 *   (idempotent) and announces nothing.
 *
 * Owns: device rules. Must not: return private material, show a device to a stranger, or let an
 * audit failure undo or block a revocation.
 */
import { isId, newId, type Api } from '@centcom/contracts';
import {
  noopMetrics,
  notFound,
  validationFailed,
  type AuditEvent,
  type FieldError,
  type Logger,
  type Metrics,
  type Page,
  type PageParams,
  type PubSub,
} from '@centcom/core';
import type { DeviceRecord } from '@centcom/db';
import type { TokenService } from '../auth/tokens/service.js';
import { deviceFingerprint } from './fingerprint.js';
import { checkPublicKeys } from './pubkeys.js';
import type { DeviceStore } from './repo.js';

/** `last_seen_at` is written at most this often per device. */
export const TOUCH_INTERVAL_MS = 5 * 60_000;
/** Devices whose last touch is remembered in process; the oldest is forgotten first. */
export const TOUCH_MEMORY_MAX = 10_000;
/** Where revocations are announced for the relay (internal convention, no contract). */
export const DEVICES_REVOKED_CHANNEL = 'devices:revoked';
/** Attempts at publishing one revocation, the first included. */
export const PUBLISH_ATTEMPTS = 6;
/** First wait between publish attempts; it doubles each time (0.5, 1, 2, 4, 8 s). */
export const PUBLISH_RETRY_BASE_MS = 500;
/** Longest device name. */
export const DEVICE_NAME_MAX = 80;
/** CT-API-ACCOUNTS `Device.platform`. */
export const DEVICE_PLATFORMS: readonly Api.Device['platform'][] = [
  'linux',
  'macos',
  'windows',
  'web',
  'other',
];

/** What registering a device takes (B020 interface). */
export interface RegisterDeviceInput {
  userId: string;
  name: string;
  platform: string;
  /** base64url, 32 bytes. */
  x25519: string;
  /** base64url, 32 bytes. */
  ed25519: string;
}

/** Dependencies of the service. */
export interface DeviceServiceDeps {
  store: DeviceStore;
  tokens: Pick<TokenService, 'revokeDevice'>;
  pubsub: Pick<PubSub, 'publish'>;
  /** B036's emitter; without it nothing is audited (tests). */
  audit?: { emitDetached(event: AuditEvent): void };
  logger?: Logger;
  metrics?: Metrics;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  /** Waits between publish attempts; default a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The details of the service's refusals (GUIDELINES §3.4). */
export const DEVICE_DETAILS = Object.freeze({
  notFound: 'There is no such device.',
} as const);

const deviceNotFound = () => notFound(DEVICE_DETAILS.notFound);
const timer = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A device as CT-API-ACCOUNTS `Device`; `current` when it is the caller's own device. */
export function deviceView(row: DeviceRecord, currentDeviceId?: string | null): Api.Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at === null ? null : row.last_seen_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    key_fingerprint: row.fingerprint,
    ...(currentDeviceId === undefined ? {} : { current: row.id === currentDeviceId }),
  };
}

/** The device rules over a store. */
export class DeviceService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly metrics: Metrics;
  /** Last touch per device, oldest first (Map insertion order). */
  private readonly touched = new Map<string, number>();
  /** Background publish retries still running. */
  private readonly retrying = new Set<Promise<void>>();

  constructor(private readonly deps: DeviceServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? timer;
    this.metrics = deps.metrics ?? noopMetrics;
  }

  /** Registers a device for `input.userId`; 422 `validation_failed` naming each bad field. */
  async registerDevice(input: RegisterDeviceInput): Promise<Api.Device> {
    const errors: FieldError[] = [];
    if (!isId('usr', input.userId)) {
      errors.push({ pointer: '/userId', code: 'invalid_format', detail: 'must be a usr_ id' });
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || [...name].length > DEVICE_NAME_MAX) {
      errors.push({
        pointer: '/name',
        code: 'invalid_length',
        detail: `must be 1 to ${DEVICE_NAME_MAX} characters`,
      });
    }
    if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(input.platform)) {
      errors.push({
        pointer: '/platform',
        code: 'invalid_value',
        detail: `must be one of ${DEVICE_PLATFORMS.join(', ')}`,
      });
    }
    const keys = checkPublicKeys(input);
    if (!keys.ok) errors.push(...keys.errors);
    if (errors.length > 0 || !keys.ok) throw validationFailed(errors);
    const row = await this.deps.store.insert({
      id: newId('dev'),
      user_id: input.userId,
      name,
      platform: input.platform as Api.Device['platform'],
      x25519_pub: input.x25519,
      ed25519_pub: input.ed25519,
      fingerprint: deviceFingerprint(keys.x25519, keys.ed25519),
    });
    return deviceView(row);
  }

  /** Records that the device was seen now; writes at most once per 5 minutes per device. */
  async touchDevice(deviceId: string): Promise<void> {
    if (!isId('dev', deviceId)) return;
    const now = this.now();
    const last = this.touched.get(deviceId);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    this.touched.delete(deviceId);
    this.touched.set(deviceId, now);
    if (this.touched.size > TOUCH_MEMORY_MAX) {
      const oldest = this.touched.keys().next().value;
      if (oldest !== undefined) this.touched.delete(oldest);
    }
    await this.deps.store.touch(deviceId, new Date(now), TOUCH_INTERVAL_MS);
  }

  /** One page of `userId`'s devices, newest first. */
  async list(
    userId: string,
    params: PageParams,
    currentDeviceId?: string | null,
  ): Promise<Page<Api.Device>> {
    const page = await this.deps.store.listForUser(userId, params);
    return { ...page, data: page.data.map((row) => deviceView(row, currentDeviceId ?? null)) };
  }

  /** `userId`'s device `deviceId`; 404 for anything else. */
  async get(
    userId: string,
    deviceId: string,
    currentDeviceId?: string | null,
  ): Promise<Api.Device> {
    return deviceView(await this.owned(userId, deviceId), currentDeviceId ?? null);
  }

  /**
   * The device's public keys, for its owner or a user sharing a session with the owner; 404 for
   * anyone else. Revoked devices keep answering, with `revoked: true`.
   */
  async keys(userId: string, deviceId: string): Promise<Api.DeviceKeys> {
    const row = isId('dev', deviceId) ? await this.deps.store.findById(deviceId) : null;
    if (row === null) throw deviceNotFound();
    if (row.user_id !== userId && !(await this.deps.store.shareSession(userId, row.user_id))) {
      throw deviceNotFound();
    }
    return {
      device: row.id,
      x25519: row.x25519_pub,
      ed25519: row.ed25519_pub,
      fingerprint: row.fingerprint,
      revoked: row.revoked_at !== null,
    };
  }

  /**
   * Revokes `actorUserId`'s device `deviceId` (404 for anything else). Idempotent: a revoked
   * device answers the same, its tokens are revoked again, and nothing is announced twice.
   */
  async revokeDevice(
    actorUserId: string,
    deviceId: string,
    ctx: { requestId?: string } = {},
  ): Promise<void> {
    await this.owned(actorUserId, deviceId);
    const revokedNow = await this.deps.store.markRevoked(
      deviceId,
      actorUserId,
      new Date(this.now()),
    );
    if (revokedNow) {
      await this.announce(JSON.stringify({ device: deviceId, user: actorUserId }));
    }
    await this.deps.tokens.revokeDevice(deviceId);
    if (!revokedNow) return;
    this.metrics.counter('devices_revoked_total').inc();
    try {
      this.deps.audit?.emitDetached({
        workspaceId: null,
        actor: { type: 'user', id: actorUserId },
        action: 'auth.device_revoked',
        target: { type: 'device', id: deviceId },
        outcome: 'success',
        meta: { reason: 'user' },
        ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
      });
    } catch (err) {
      // emitDetached never throws; should a replacement ever do so, the revocation still stands.
      this.deps.logger?.error({ err, device_id: deviceId }, 'devices.audit_failed');
    }
  }

  /** Resolves once every background publish retry has finished (tests, shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.retrying]);
  }

  /** `userId`'s device, or a 404. */
  private async owned(userId: string, deviceId: string): Promise<DeviceRecord> {
    const row = isId('dev', deviceId) ? await this.deps.store.findById(deviceId) : null;
    if (row === null || row.user_id !== userId) throw deviceNotFound();
    return row;
  }

  /** Publishes a revocation; when that fails, keeps retrying in the background. Never throws. */
  private async announce(message: string): Promise<void> {
    if (await this.publishOnce(message, 1)) return;
    const retry = this.retryPublish(message).finally(() => this.retrying.delete(retry));
    this.retrying.add(retry);
  }

  private async retryPublish(message: string): Promise<void> {
    for (let attempt = 2; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
      await this.sleep(PUBLISH_RETRY_BASE_MS * 2 ** (attempt - 2));
      if (await this.publishOnce(message, attempt)) return;
    }
    this.metrics.counter('devices_revoked_publish_failed_total').inc();
    this.deps.logger?.error(
      { attempts: PUBLISH_ATTEMPTS },
      'devices.revoke_publish_failed: the relay will see the revocation on its next membership check',
    );
  }

  private async publishOnce(message: string, attempt: number): Promise<boolean> {
    try {
      await this.deps.pubsub.publish(DEVICES_REVOKED_CHANNEL, message);
      return true;
    } catch (err) {
      this.deps.logger?.warn({ err, attempt }, 'devices.revoke_publish_retry');
      return false;
    }
  }
}

/**
 * Device authorization grant (B016, CT-AUTH, RFC 8628): the terminal starts a grant and gets a
 * device_code (its secret) and a user_code (for a person); the person enters the user code on the
 * verification page, signed in, and approves or denies; the terminal's polls then get tokens bound
 * to a device registered with the keys it sent (`grant-handler.ts`).
 *
 * This file is the start and the browser side: `start` validates the request and records the
 * grant, `lookupUserCode` shows the page what it is approving, `approveDeviceGrant` and
 * `denyDeviceGrant` decide it. Wrong codes count against the user and the address: 10 within 10
 * minutes lock lookups for 15 minutes. A wrong code and an expired or used one get the same answer.
 *
 * Owns: grant creation and decisions. Must not: store or log a device_code or user_code, let a
 * grant be decided twice, or grant `admin` or a scope the client may not hold.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Api } from '@centcom/contracts';
import {
  AppError,
  tooManyRequests,
  unavailable,
  validationFailed,
  type FieldError,
  type KeyValue,
  type Logger,
} from '@centcom/core';
import { isConnectionError, type ClientId, type DevicePlatform } from '@centcom/db';
import { CLIENT_IDS } from '../tokens/service.js';
import { checkDevicePublicKeys, deviceFingerprint } from './keys.js';
import type { DeviceGrantStore } from './store.js';
import {
  formatUserCode,
  generateUserCode,
  normaliseUserCode,
  type RandomSource,
} from './usercode.js';

/** CT-AUTH: where people approve a terminal. */
export const VERIFICATION_URI = 'https://centcom.dev/device';
/** How long a grant lives (CT-AUTH: user codes live 10 minutes). */
export const DEVICE_GRANT_TTL_S = 600;
/** The first poll interval (CT-AUTH). */
export const DEFAULT_INTERVAL_S = 5;
/** Bytes of a device_code: 256 bits. */
export const DEVICE_CODE_BYTES = 32;
/** What a device_code looks like: 32 bytes, base64url without padding. */
export const DEVICE_CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** Tries for a user code no pending grant holds before giving up. */
export const USER_CODE_ATTEMPTS = 5;

/**
 * CT-AUTH's CLI default scope: what a terminal may hold. A request's scope is narrowed to these;
 * `admin` is never among them.
 */
export const DEVICE_CLIENT_SCOPES: readonly string[] = Object.freeze([
  'profile',
  'workspaces:read',
  'sessions:read',
  'sessions:write',
  'sessions:host',
  'usage:write',
  'billing:read',
]);

/** Wrong user codes allowed per user and per address within the window... */
export const LOOKUP_FAILURE_LIMIT = 10;
/** ...of this many milliseconds... */
export const LOOKUP_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** ...before lookups are refused for this long. */
export const LOOKUP_LOCKOUT_MS = 15 * 60 * 1000;

/** The longest device name (the `devices` table's limit). */
const MAX_DEVICE_NAME = 80;
/** The longest `scope` string read. */
const MAX_SCOPE_LENGTH = 512;

/** One answer for a user code that is wrong, expired, used or decided (no oracle). */
export const USER_CODE_INVALID_DETAIL = 'The code is not valid or has expired.';
export const userCodeInvalid = (): AppError =>
  new AppError('expired_token', { detail: USER_CODE_INVALID_DETAIL });
const LOCKED_DETAIL = 'Too many wrong codes. Try again later.';

/** sha256 of a device_code, hex: the only form stored. */
export const hashDeviceCode = (deviceCode: string): string =>
  createHash('sha256').update(deviceCode, 'utf8').digest('hex');

/** What the verification page shows about a grant before the person decides. */
export interface PendingGrant {
  /** As shown: `ABCD-EFGH`. */
  userCode: string;
  clientId: ClientId;
  deviceName: string;
  platform: DevicePlatform;
  /** The scopes the terminal will get. */
  scopes: string[];
  /** CT-CRYPTO fingerprint of the keys, to compare with the terminal's. */
  fingerprint: string;
  expiresAt: Date;
}

/** Who is entering a code, for the lockout: the signed-in user and the client address. */
export interface CodeAttempt {
  userId: string | null;
  ip: string | null;
}

/** Dependencies of the service. */
export interface DeviceGrantServiceDeps {
  store: DeviceGrantStore;
  /** Lockout counters (B009). */
  kv: KeyValue;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  /** Randomness for codes; default the CSPRNG. */
  random?: RandomSource;
  /** Default VERIFICATION_URI (CT-AUTH); another only for development. */
  verificationUri?: string;
  logger?: Logger;
}

/** What `start` reads from a request besides its body. */
export interface StartContext {
  /** The User-Agent header, for the device's platform. */
  userAgent?: string;
}

/** Runs a database step; a lost connection becomes a 503 that holds no connection details. */
export async function guarded<T>(fn: () => Promise<T>, retryAfterS?: number): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    throw unavailable(retryAfterS, undefined, { cause: new Error('database unavailable') });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The scopes a terminal gets: the request's, narrowed to DEVICE_CLIENT_SCOPES (all when absent). */
export function deviceScopes(requested: string | undefined): string[] {
  if (requested === undefined) return [...DEVICE_CLIENT_SCOPES];
  const asked = new Set(requested.split(' ').filter((s) => s !== ''));
  return DEVICE_CLIENT_SCOPES.filter((scope) => asked.has(scope));
}

/**
 * The device's platform from a CT-VER User-Agent (`centcom-cli/1.4.2 (contract/1.0.0;
 * linux-x64; node/22.9.0)`); `web` for the web client; `other` when it does not say.
 */
export function platformOf(clientId: ClientId, userAgent: string | undefined): DevicePlatform {
  if (clientId === 'centcom-web') return 'web';
  const os = /\(([^)]*)\)/
    .exec(userAgent ?? '')?.[1]
    ?.split(';')
    .map((part) => part.trim().toLowerCase())
    .find((part) => !part.startsWith('contract/') && !part.includes('/'))
    ?.split('-')[0];
  switch (os) {
    case 'linux':
      return 'linux';
    case 'darwin':
    case 'macos':
      return 'macos';
    case 'win32':
    case 'windows':
      return 'windows';
    default:
      return 'other';
  }
}

/** The checked start request. */
interface StartRequest {
  clientId: ClientId;
  scopes: string[];
  deviceName: string;
  keys: { x25519: string; ed25519: string };
}

/**
 * Checks a `POST /v1/auth/device/code` body: 401 `invalid_client` (pointer `/client_id`) for a
 * client that is not one of CT-AUTH's, 422 `validation_failed` with every field error otherwise,
 * 400 `invalid_scope` when nothing of the requested scope may be granted.
 */
export function checkStartRequest(body: unknown): StartRequest {
  if (!isRecord(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const clientId = body['client_id'];
  if (typeof clientId !== 'string' || !(CLIENT_IDS as readonly string[]).includes(clientId)) {
    throw new AppError('invalid_client', {
      detail: 'The client is not known.',
      errors: [{ pointer: '/client_id', code: 'invalid_value', detail: 'is not a known client' }],
    });
  }
  const errors: FieldError[] = [];
  const scope = body['scope'];
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > MAX_SCOPE_LENGTH)) {
    errors.push({
      pointer: '/scope',
      code: 'invalid_type',
      detail: 'must be a space-separated string',
    });
  }
  const name = body['device_name'];
  if (name === undefined) {
    errors.push({ pointer: '/device_name', code: 'required', detail: 'is required' });
  } else if (typeof name !== 'string') {
    errors.push({ pointer: '/device_name', code: 'invalid_type', detail: 'must be a string' });
  } else if (name.trim() === '' || [...name].length > MAX_DEVICE_NAME || /\p{Cc}/u.test(name)) {
    errors.push({
      pointer: '/device_name',
      code: 'invalid_value',
      detail: `must be 1 to ${MAX_DEVICE_NAME} characters without control characters`,
    });
  }
  const keys = checkDevicePublicKeys(body['device_pubkeys']);
  if ('errors' in keys) errors.push(...keys.errors);
  for (const key of Object.keys(body)) {
    if (!['client_id', 'scope', 'device_name', 'device_pubkeys'].includes(key)) {
      errors.push({
        pointer: `/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        code: 'not_allowed',
        detail: 'is not a known field',
      });
    }
  }
  if (errors.length > 0 || 'errors' in keys) {
    throw validationFailed(errors, 'Some fields are not valid.');
  }
  const scopes = deviceScopes(scope as string | undefined);
  if (scopes.length === 0) {
    throw new AppError('invalid_scope', { detail: 'None of the requested scopes may be granted.' });
  }
  return {
    clientId: clientId as ClientId,
    scopes,
    deviceName: (name as string).trim(),
    keys: keys.keys,
  };
}

/** The device flow's start and browser side. */
export class DeviceGrantService {
  readonly #store: DeviceGrantStore;
  readonly #kv: KeyValue;
  readonly #now: () => number;
  readonly #random: RandomSource;
  readonly #verificationUri: string;
  readonly #logger: Logger | undefined;

  constructor(deps: DeviceGrantServiceDeps) {
    this.#store = deps.store;
    this.#kv = deps.kv;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? randomBytes;
    this.#verificationUri = deps.verificationUri ?? VERIFICATION_URI;
    this.#logger = deps.logger;
  }

  /** `POST /v1/auth/device/code`: records a grant and returns its codes (CT-AUTH `DeviceCodeResponse`). */
  async start(body: unknown, ctx: StartContext = {}): Promise<Api.DeviceCodeResponse> {
    const request = checkStartRequest(body);
    const deviceCode = Buffer.from(this.#random(DEVICE_CODE_BYTES)).toString('base64url');
    const expiresAt = new Date(this.#now() + DEVICE_GRANT_TTL_S * 1000);
    for (let attempt = 1; ; attempt++) {
      const userCode = generateUserCode(this.#random);
      const outcome = await guarded(() =>
        this.#store.insert({
          deviceCodeHash: hashDeviceCode(deviceCode),
          userCode,
          clientId: request.clientId,
          scope: request.scopes.join(' '),
          deviceName: request.deviceName,
          platform: platformOf(request.clientId, ctx.userAgent),
          x25519Pub: request.keys.x25519,
          ed25519Pub: request.keys.ed25519,
          intervalS: DEFAULT_INTERVAL_S,
          expiresAt,
        }),
      );
      if (outcome === 'inserted') {
        this.#logger?.info({ client_id: request.clientId }, 'auth.device_grant.started');
        const shown = formatUserCode(userCode);
        return {
          device_code: deviceCode,
          user_code: shown,
          verification_uri: this.#verificationUri,
          verification_uri_complete: `${this.#verificationUri}?user_code=${shown}`,
          expires_in: DEVICE_GRANT_TTL_S,
          interval: DEFAULT_INTERVAL_S,
        };
      }
      if (attempt >= USER_CODE_ATTEMPTS) {
        throw unavailable(1, undefined, { cause: new Error('no free user code') });
      }
    }
  }

  /**
   * The pending grant behind what a person typed, for the verification page; null for a code that
   * is wrong, expired or already decided (the same null). Counts wrong codes; 429 while locked.
   */
  async lookupUserCode(input: string, attempt: CodeAttempt): Promise<PendingGrant | null> {
    await this.#checkLock(attempt);
    const userCode = normaliseUserCode(input);
    const grant =
      userCode === null
        ? null
        : await guarded(() => this.#store.findPending(userCode, new Date(this.#now())));
    if (grant === null) {
      await this.#countFailure(attempt);
      return null;
    }
    return {
      userCode: formatUserCode(grant.userCode),
      clientId: grant.clientId,
      deviceName: grant.deviceName,
      platform: grant.platform,
      scopes: grant.scope.split(' '),
      fingerprint: deviceFingerprint({ x25519: grant.x25519Pub, ed25519: grant.ed25519Pub }),
      expiresAt: grant.expiresAt,
    };
  }

  /**
   * The signed-in person approves the pending grant behind `userCode`; the terminal's next poll
   * gets tokens. 400 `expired_token` for a wrong, expired or already decided code (counted).
   */
  async approveDeviceGrant(
    userCode: string,
    userId: string,
    ip: string | null = null,
  ): Promise<void> {
    await this.#decide(userCode, userId, 'approved', ip);
  }

  /** The signed-in person denies the grant; the terminal's next poll gets `access_denied`. */
  async denyDeviceGrant(userCode: string, userId: string, ip: string | null = null): Promise<void> {
    await this.#decide(userCode, userId, 'denied', ip);
  }

  async #decide(
    input: string,
    userId: string,
    status: 'approved' | 'denied',
    ip: string | null,
  ): Promise<void> {
    const attempt = { userId, ip };
    await this.#checkLock(attempt);
    const userCode = normaliseUserCode(input);
    const decided =
      userCode !== null &&
      (await guarded(() => this.#store.decide(userCode, userId, status, new Date(this.#now()))));
    if (!decided) {
      await this.#countFailure(attempt);
      throw userCodeInvalid();
    }
    this.#logger?.info({ user_id: userId, decision: status }, 'auth.device_grant.decided');
  }

  /** KV keys of an attempt: one per user, one per address (hashed: no raw addresses in Redis). */
  #subjects(attempt: CodeAttempt): string[] {
    const subjects: string[] = [];
    if (attempt.userId !== null) subjects.push(`user:${attempt.userId}`);
    if (attempt.ip !== null) {
      subjects.push(
        `ip:${createHash('sha256').update(attempt.ip, 'utf8').digest('hex').slice(0, 32)}`,
      );
    }
    return subjects;
  }

  /** 429 `rate_limited` while the user or the address is locked out. */
  async #checkLock(attempt: CodeAttempt): Promise<void> {
    for (const subject of this.#subjects(attempt)) {
      const left = await this.#kv.ttl(`device-grant:lock:${subject}`);
      if (left !== null) throw tooManyRequests(Math.max(1, Math.ceil(left / 1000)), LOCKED_DETAIL);
    }
  }

  /** Counts a wrong code; the LOOKUP_FAILURE_LIMIT-th within the window locks the subject. */
  async #countFailure(attempt: CodeAttempt): Promise<void> {
    for (const subject of this.#subjects(attempt)) {
      const failures = await this.#kv.incr(
        `device-grant:fail:${subject}`,
        LOOKUP_FAILURE_WINDOW_MS,
      );
      if (failures >= LOOKUP_FAILURE_LIMIT) {
        await this.#kv.set(`device-grant:lock:${subject}`, '1', { ttlMs: LOOKUP_LOCKOUT_MS });
        await this.#kv.del(`device-grant:fail:${subject}`);
        this.#logger?.warn(
          {
            subject: subject.startsWith('user:') ? 'user' : 'address',
            ...(attempt.userId === null ? {} : { user_id: attempt.userId }),
          },
          'auth.device_grant.lookup_locked',
        );
      }
    }
  }
}

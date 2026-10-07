/**
 * The device_code grant of `POST /v1/auth/token` (B016, RFC 8628 §3.4-3.5), registered into the
 * token service's grant registry (B017). A poll gets, as problem+json:
 *
 * - 400 `authorization_pending` while nobody has decided (`retry_after_s`: the interval);
 * - 400 `slow_down` when it came sooner than the interval, which grows by 5 s and is persisted;
 * - 403 `access_denied` after the person denied it;
 * - 400 `expired_token` for a device_code that is unknown, expired, already used, or was started
 *   by another client: one body for all of them;
 * - tokens once approved: the device is registered and the tokens issued in one transaction, and
 *   the grant is spent, so exactly one poll ever gets them;
 * - 503 `service_unavailable` with `retry_after_s` when the database is down; polling continues.
 *
 * Owns: answering polls. Must not: log a device_code or a token, issue tokens twice for a grant,
 * or bind them to anything but the new device.
 */
import { AppError } from '@centcom/core';
import type { TokenRequest, TokenResponse, TokenService } from '../tokens/service.js';
import { DEFAULT_INTERVAL_S, DEVICE_CODE_SHAPE, guarded, hashDeviceCode } from './service.js';
import type { DeviceGrantStore } from './store.js';

/** RFC 8628's grant type. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Details of the poll answers (fixed English). */
export const POLL_DETAILS = Object.freeze({
  pending: 'The user has not approved this device yet.',
  slowDown: 'Polling too fast: wait the interval between polls.',
  denied: 'The user denied this device.',
  expired: 'The device code is not valid or has expired. Start again.',
});

/** Dependencies of the handler. */
export interface DeviceGrantHandlerDeps {
  store: DeviceGrantStore;
  tokens: Pick<TokenService, 'issueTokens'>;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
}

/** Answers device_code polls (see the file comment). */
export function createDeviceGrantHandler(
  deps: DeviceGrantHandlerDeps,
): (request: TokenRequest) => Promise<TokenResponse> {
  const now = deps.now ?? Date.now;
  return async (request) => {
    const deviceCode = request['device_code'];
    if (typeof deviceCode !== 'string' || deviceCode === '') {
      throw new AppError('invalid_request', { detail: 'device_code is required.' });
    }
    if (!DEVICE_CODE_SHAPE.test(deviceCode)) {
      throw new AppError('expired_token', { detail: POLL_DETAILS.expired });
    }
    const outcome = await guarded(
      () =>
        deps.store.poll(
          hashDeviceCode(deviceCode),
          request.client_id,
          new Date(now()),
          (device, tx) =>
            deps.tokens.issueTokens(
              {
                userId: device.userId,
                deviceId: device.deviceId,
                scopes: device.scope.split(' '),
                clientId: device.clientId,
              },
              tx,
            ),
        ),
      DEFAULT_INTERVAL_S,
    );
    switch (outcome.kind) {
      case 'issued':
        return outcome.result;
      case 'pending':
        throw new AppError('authorization_pending', {
          detail: POLL_DETAILS.pending,
          retryAfterS: outcome.intervalS,
        });
      case 'slow_down':
        throw new AppError('slow_down', {
          detail: POLL_DETAILS.slowDown,
          retryAfterS: outcome.intervalS,
        });
      case 'denied':
        throw new AppError('access_denied', { detail: POLL_DETAILS.denied });
      case 'expired':
        throw new AppError('expired_token', { detail: POLL_DETAILS.expired });
    }
  };
}

/** Registers the device_code grant with the token service. */
export function registerDeviceGrant(
  tokens: TokenService,
  store: DeviceGrantStore,
  now?: () => number,
): void {
  tokens.registerGrantHandler(
    DEVICE_CODE_GRANT_TYPE,
    createDeviceGrantHandler({ store, tokens, ...(now === undefined ? {} : { now }) }),
  );
}

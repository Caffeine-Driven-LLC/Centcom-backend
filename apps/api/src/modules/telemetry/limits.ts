/**
 * Telemetry rate limits (B085): at most 120 batches a minute per client address and 12 per
 * `install_id`. A batch past either is dropped (`rate_limited`) and still answered 204, without
 * `Retry-After`.
 *
 * Addresses are never stored or logged: the per-address key is an HMAC of the address under a
 * secret salt and the current hour, so a key in Redis cannot be traced to an address, and keys of
 * different hours do not match. Keys live as long as their 60 s window. When Redis cannot answer,
 * the batch is dropped (telemetry is the first thing to shed).
 *
 * Owns: the limits and the keys. Must not: keep an address, or tie an install to an address.
 */
import { createHmac } from 'node:crypto';
import type { RateLimitStore, Secret } from '@centcom/core';

/** Batches a minute per address. */
export const IP_BATCHES_PER_MINUTE = 120;
/** Batches a minute per install. */
export const INSTALL_BATCHES_PER_MINUTE = 12;
const WINDOW_S = 60;
const HOUR_MS = 60 * 60 * 1000;

/** The per-address key: `telemetry:ip:<hex HMAC of hour and address>`. */
export function addressKey(salt: Secret<string>, ip: string, now: number): string {
  const hour = Math.floor(now / HOUR_MS);
  const digest = createHmac('sha256', salt.reveal()).update(`${hour}:${ip}`).digest('hex');
  return `telemetry:ip:${digest.slice(0, 32)}`;
}

/** Counts batches by address and install. */
export class TelemetryLimits {
  constructor(
    private readonly store: Pick<RateLimitStore, 'consume'>,
    private readonly salt: Secret<string>,
  ) {}

  /** False when the address has sent its 120 batches this minute (or Redis cannot say). */
  async address(ip: string, now: number): Promise<boolean> {
    try {
      return (
        await this.store.consume(addressKey(this.salt, ip, now), IP_BATCHES_PER_MINUTE, WINDOW_S)
      ).allowed;
    } catch {
      return false;
    }
  }

  /** False when the install has sent its 12 batches this minute (or Redis cannot say). */
  async install(installId: string): Promise<boolean> {
    try {
      return (
        await this.store.consume(
          `telemetry:install:${installId}`,
          INSTALL_BATCHES_PER_MINUTE,
          WINDOW_S,
        )
      ).allowed;
    } catch {
      return false;
    }
  }
}

/**
 * Percentage buckets (B083, CT-API-FLAGS: "percentage rollouts hash the `usr_` id"): a user's
 * bucket for a flag is the first 32 bits of SHA-256 over `<flag key>:<user id>` (UTF-8), modulo
 * 10 000. The same user always lands in the same bucket for a flag, and buckets of different flags
 * are independent, so raising a flag's percentage only ever adds users. A rollout of p % lets in
 * buckets below p × 100.
 *
 * Owns: the bucket function. Must not: change (every rollout would reshuffle).
 */
import { createHash } from 'node:crypto';

/** Buckets: percentages have two decimals. */
export const BUCKETS = 10_000;

/** `userId`'s bucket for flag `key`, 0..9 999. */
export function bucketOf(key: string, userId: string): number {
  return createHash('sha256').update(`${key}:${userId}`, 'utf8').digest().readUInt32BE(0) % BUCKETS;
}

/** True when `userId` is in a rollout of `basisPoints` (0..10 000) of flag `key`. */
export function inRollout(key: string, userId: string, basisPoints: number): boolean {
  return bucketOf(key, userId) < basisPoints;
}

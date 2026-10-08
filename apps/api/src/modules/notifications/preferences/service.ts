/**
 * Notification preferences (B066, CT-API-NOTIFY): read and replace a user's document, and serve
 * it to the dispatcher as B063's `PreferencesPort`.
 *
 * - A user who never saved preferences gets the defaults, at version 0.
 * - A stored document that no longer validates is read leniently (valid parts kept, defaults for
 *   the rest) with a warning naming the user and the dropped pointers: never a 500.
 * - `replace` writes a complete, validated document. With If-Match, it writes only at a version
 *   the header names (compare-and-set in SQL); otherwise the last write wins. Each write moves the
 *   version, and so the ETag, on by one.
 * - A database timeout or lost connection is a 503 with `retry_after_s`.
 *
 * Owns: the read and write rules. Must not: store anything but the document.
 */
import { unavailable, type Logger } from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import type { IfMatch } from '../../me/etag.js';
import type { PreferencesPort } from '../dispatcher/ports.js';
import type { PreferencesRepository } from './repository.js';
import { defaultPreferences, readStoredPreferences, type CompletePreferences } from './schema.js';

/** The details of the service's refusals (GUIDELINES §3.4). */
export const PREFERENCES_DETAILS = Object.freeze({
  stale: 'The notification preferences changed since that ETag; read them again.',
  unavailable: 'Notification preferences are unavailable. Try again shortly.',
} as const);

/** A document and its version (0: the defaults, never saved). */
export interface VersionedPreferences {
  prefs: CompletePreferences;
  version: number;
}

/** What the service needs. */
export interface PreferencesServiceDeps {
  repository: PreferencesRepository;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
}

/** A database failure that is the database's fault (timeout, lost connection): a 503. */
function databaseFailure(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    throw unavailable(1, PREFERENCES_DETAILS.unavailable, {
      cause: new Error('database unavailable'),
    });
  }
  throw err;
}

const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    return databaseFailure(err);
  }
};

/** Notification preferences; B063's `PreferencesPort`. */
export class PreferencesService implements PreferencesPort {
  readonly #clock: () => number;

  constructor(private readonly deps: PreferencesServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  /** The user's document and version: the defaults at version 0 when they never saved one. */
  async read(userId: string): Promise<VersionedPreferences> {
    const stored = await guarded(() => this.deps.repository.find(userId));
    if (stored === null) return { prefs: defaultPreferences(), version: 0 };
    const { prefs, issues } = readStoredPreferences(stored.doc);
    if (issues.length > 0) {
      this.deps.logger?.warn(
        { user_id: userId, version: stored.version, dropped: issues.map((i) => i.pointer) },
        'notification_prefs.stored_invalid',
      );
    }
    return { prefs, version: stored.version };
  }

  /** B063's port: the user's preferences, the defaults when they never saved any. */
  async get(userId: string): Promise<CompletePreferences> {
    return (await this.read(userId)).prefs;
  }

  /**
   * Replaces the user's document with `prefs` (complete and validated: `parsePreferences`).
   * Returns the new version, or 'stale' when If-Match names no current version.
   */
  async replace(
    userId: string,
    prefs: CompletePreferences,
    ifMatch?: IfMatch,
  ): Promise<VersionedPreferences | 'stale'> {
    const now = new Date(this.#clock());
    const doc = prefs as unknown as Record<string, unknown>;
    let expected: number[] | undefined;
    if (ifMatch !== undefined && !ifMatch.any) {
      expected = ifMatch.versions.map(Number).filter((v) => Number.isSafeInteger(v));
      if (expected.length === 0) return 'stale';
    }
    const version = await guarded(() => this.deps.repository.save(userId, doc, now, expected));
    return version === null ? 'stale' : { prefs, version };
  }
}

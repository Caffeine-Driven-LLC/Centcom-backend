/**
 * The allow-list (B101): `secret-guard.allow.json` entries that tell the guard a pattern is
 * expected at a place (a path, a route, a log component). An entry names a pattern id and a
 * location, with a reason and an expiry; it can never name content, so a leaked key cannot be
 * allowed by pasting it here.
 *
 * Owns: validating and matching entries. Must not: accept a content string, an entry without a
 * reason or past its expiry, an unknown pattern id or more than MAX_ALLOW_ENTRIES entries.
 */
import { readFileSync } from 'node:fs';
import { loadPatterns } from './patterns.js';

/** At most this many entries; more is a configuration error. */
export const MAX_ALLOW_ENTRIES = 20;
/** Where an entry applies. */
export const ALLOW_SCOPES = ['path', 'route', 'log_component'] as const;
export type AllowScope = (typeof ALLOW_SCOPES)[number];

/** One validated entry. */
export interface AllowEntry {
  readonly pattern_id: string;
  readonly scope: AllowScope;
  readonly value: string;
  readonly reason: string;
  /** `YYYY-MM-DD`; the entry works through the end of that day (UTC). */
  readonly expires: string;
}

/** Where a scan is happening; each surface fills the one that applies. */
export interface Location {
  /** Repo-relative path with `/` separators (CI scan). */
  readonly path?: string;
  /** Route template, such as `/v1/sessions/:id` (REST). */
  readonly route?: string;
  /** Logger component name (log surface). */
  readonly logComponent?: string;
}

/** A checked list. */
export interface AllowList {
  readonly entries: readonly AllowEntry[];
  /** True when an entry covers `patternId` at `location`. */
  allows(patternId: string, location: Location | undefined): boolean;
}

/** The configuration was wrong; the message names the entry number and the problem, never a value. */
export class AllowListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowListError';
  }
}

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'pattern_id',
  'scope',
  'value',
  'reason',
  'expires',
]);

/** The list with no entries. */
export const EMPTY_ALLOW_LIST: AllowList = Object.freeze({
  entries: Object.freeze([]) as readonly AllowEntry[],
  allows: () => false,
});

function covers(entry: AllowEntry, location: Location): boolean {
  switch (entry.scope) {
    case 'path': {
      const path = location.path;
      if (path === undefined) return false;
      const prefix = entry.value.endsWith('/') ? entry.value : `${entry.value}/`;
      return path === entry.value || path.startsWith(prefix);
    }
    case 'route':
      return location.route === entry.value;
    case 'log_component':
      return location.logComponent === entry.value;
  }
}

/**
 * Checks `raw` (the parsed file: `{ entries: [...] }`) and builds the list. Throws `AllowListError`.
 * `now` is for tests.
 */
export function createAllowList(raw: unknown, now: Date = new Date()): AllowList {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    throw new AllowListError('the allow-list must be an object with an "entries" array');
  }
  const rows = (raw as { entries: unknown[] }).entries;
  if (rows.length > MAX_ALLOW_ENTRIES) {
    throw new AllowListError(
      `the allow-list has ${rows.length} entries; the most allowed is ${MAX_ALLOW_ENTRIES}`,
    );
  }
  const known = new Set(loadPatterns().map((p) => p.id));
  const entries = rows.map((row, i): AllowEntry => {
    const at = `entry ${i + 1}`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new AllowListError(`${at} must be an object`);
    }
    const r = row as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!ENTRY_KEYS.has(key)) throw new AllowListError(`${at} has an unknown field "${key}"`);
    }
    const { pattern_id: patternId, scope, value, reason, expires } = r;
    if (typeof patternId !== 'string' || !known.has(patternId)) {
      throw new AllowListError(`${at}: pattern_id must be one of the contract pattern ids`);
    }
    if (typeof scope !== 'string' || !(ALLOW_SCOPES as readonly string[]).includes(scope)) {
      throw new AllowListError(`${at}: scope must be one of ${ALLOW_SCOPES.join(', ')}`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AllowListError(`${at}: value (a location) is required`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new AllowListError(`${at}: a reason is required`);
    }
    if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      throw new AllowListError(`${at}: expires must be a YYYY-MM-DD date`);
    }
    const end = new Date(`${expires}T23:59:59.999Z`);
    // V8 rolls 2999-02-31 over to March; a real date reads back unchanged.
    if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== expires) {
      throw new AllowListError(`${at}: expires is not a real date`);
    }
    if (end.getTime() < now.getTime()) throw new AllowListError(`${at}: expired on ${expires}`);
    return Object.freeze({
      pattern_id: patternId,
      scope: scope as AllowScope,
      value,
      reason,
      expires,
    });
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    allows: (patternId: string, location: Location | undefined) =>
      location !== undefined &&
      entries.some((e) => e.pattern_id === patternId && covers(e, location)),
  });
}

/** Reads and checks the file at `path`. Throws `AllowListError` for bad content. */
export function loadAllowListFile(path: string, now?: Date): AllowList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AllowListError('the allow-list file cannot be read as JSON');
  }
  return createAllowList(parsed, now);
}

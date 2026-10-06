/**
 * Prefixed ULID identifiers (CT-IDS): `<prefix>_<26-char Crockford base32 ULID>`.
 *
 * Owns: the prefix table, ID creation (a monotonic ULID generator with injectable clock and
 * randomness) and ID checks. Must not: give IDs any meaning beyond sort order, use a non-CSPRNG
 * source by default, or throw on external input (checks return false/null).
 */
import { randomFillSync } from 'node:crypto';

/** Every entity prefix in the CT-IDS table (contracts/00-foundations.md), in table order. */
export const ID_PREFIXES = [
  'usr',
  'ses',
  'wsp',
  'agt',
  'dev',
  'que',
  'mem',
  'msg',
  'inv',
  'apr',
  'key',
  'sub',
  'whk',
  'dlv',
  'ntf',
  'aud',
  'snp',
  'prj',
  'blb',
  'req',
  'exp',
  'psh',
  'use',
  'inc',
] as const;

/** A CT-IDS entity prefix. */
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** CT-IDS: an ID is at most 40 bytes. Every well-formed ID is 30 ASCII bytes. */
export const MAX_ID_BYTES = 40;

/** Clock and randomness for ID creation; both default to the platform (Date.now, CSPRNG). */
export interface IdDeps {
  /** Milliseconds since the Unix epoch. */
  now?: () => number;
  /** 10 random bytes (80 bits) per call. Inject only in tests; the default is the CSPRNG. */
  random?: () => Uint8Array;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PATTERN = /^([a-z]{3})_([0-9A-HJKMNP-TV-Z]{26})$/;
const MAX_TIME = 2 ** 48 - 1;
const RANDOM_BYTES = 10;
const PREFIXES: ReadonlySet<string> = new Set(ID_PREFIXES);

const defaultRandom = (): Uint8Array => randomFillSync(new Uint8Array(RANDOM_BYTES));

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 80 bits as 16 base32 chars, 40 bits (5 bytes, exact in a double) at a time. */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  for (let half = 0; half < 2; half++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + (bytes[half * 5 + i] ?? 0);
    let chunk = '';
    for (let i = 0; i < 8; i++) {
      chunk = ALPHABET.charAt(n % 32) + chunk;
      n = Math.floor(n / 32);
    }
    out += chunk;
  }
  return out;
}

/** Adds one to an 80-bit big-endian number in place; returns false when it wraps to zero. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const v = (bytes[i] ?? 0) + 1;
    bytes[i] = v & 0xff;
    if (v <= 0xff) return true;
  }
  return false;
}

/**
 * Monotonic ULID state: within one generator every new ID sorts after the previous one, even when
 * the clock repeats a millisecond or moves backwards (the previous random part is incremented).
 */
class UlidState {
  private lastTime = -1;
  private readonly lastRandom = new Uint8Array(RANDOM_BYTES);

  next(prefix: IdPrefix, now: () => number, random: () => Uint8Array): string {
    if (!PREFIXES.has(prefix)) throw new TypeError(`unknown ID prefix ${JSON.stringify(prefix)}`);
    const time = Math.floor(now());
    if (!Number.isFinite(time) || time < 0 || time > MAX_TIME) {
      throw new RangeError(`clock value ${time} is outside the 48-bit ULID range`);
    }
    if (time > this.lastTime) {
      this.lastTime = time;
      this.fill(random);
    } else if (!increment(this.lastRandom)) {
      // 80 bits of randomness exhausted within one millisecond: move to the next one.
      if (this.lastTime >= MAX_TIME) throw new RangeError('ULID time overflow');
      this.lastTime += 1;
      this.fill(random);
    }
    return `${prefix}_${encodeTime(this.lastTime)}${encodeRandom(this.lastRandom)}`;
  }

  private fill(random: () => Uint8Array): void {
    const bytes = random();
    if (bytes.length !== RANDOM_BYTES) throw new RangeError(`random() must return ${RANDOM_BYTES} bytes`);
    this.lastRandom.set(bytes);
  }
}

/**
 * Creates an independent monotonic generator, e.g. with a frozen clock in tests.
 * @returns a function that makes the next ID for a prefix
 */
export function createIdGenerator(deps: IdDeps = {}): (prefix: IdPrefix) => string {
  const state = new UlidState();
  const now = deps.now ?? Date.now;
  const random = deps.random ?? defaultRandom;
  return (prefix) => state.next(prefix, now, random);
}

const processState = new UlidState();

/**
 * Makes a new ID with the process-wide monotonic generator (client-generated `que_`, `msg_`,
 * `apr_` IDs MUST come from one, CT-IDS). `deps` replaces the clock or randomness for this call.
 */
export function newId(prefix: IdPrefix, deps: IdDeps = {}): string {
  return processState.next(prefix, deps.now ?? Date.now, deps.random ?? defaultRandom);
}

/** Splits a well-formed ID into its prefix and ULID; null for anything else. Never throws. */
export function parseId(value: unknown): { prefix: IdPrefix; ulid: string } | null {
  // The length guard comes first so a hostile multi-megabyte string never reaches the regex.
  if (typeof value !== 'string' || value.length > MAX_ID_BYTES) return null;
  const m = ID_PATTERN.exec(value);
  if (!m || !PREFIXES.has(m[1] ?? '')) return null;
  return { prefix: m[1] as IdPrefix, ulid: m[2] ?? '' };
}

/** True if `value` is a well-formed ID with exactly this prefix. Never throws. */
export function isId(prefix: IdPrefix, value: unknown): value is string {
  return parseId(value)?.prefix === prefix;
}

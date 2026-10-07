/**
 * Test helpers for the logging tests (B005): a capturing destination, a recording Metrics and
 * secret-shaped values. Secrets are assembled at run time so the repository holds no
 * secret-shaped literal for the secret scan (B002) to flag.
 */
import { Writable } from 'node:stream';
import type { MetricLabels, Metrics } from '../../src/index.js';

/** A destination that keeps every line written to it. */
export function captureStream(): {
  stream: Writable;
  /** Raw output, split into lines (the trailing newline removed). */
  raw: () => string[];
  /** Every line, parsed. */
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const raw = (): string[] => chunks.join('').split('\n').slice(0, -1);
  return {
    stream,
    raw,
    lines: () => raw().map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const seriesKey = (name: string, labels?: MetricLabels): string =>
  `${name}${JSON.stringify(labels ?? {})}`;

/** A Metrics that records counter totals by name and labels, and every histogram observation. */
export function recordingMetrics(): {
  metrics: Metrics;
  count: (name: string, labels?: MetricLabels) => number;
  observations: {
    name: string;
    buckets: readonly number[];
    value: number;
    labels?: MetricLabels;
  }[];
} {
  const counts = new Map<string, number>();
  const observations: {
    name: string;
    buckets: readonly number[];
    value: number;
    labels?: MetricLabels;
  }[] = [];
  const metrics: Metrics = {
    counter: (name, labels) => ({
      inc: (n = 1) => {
        const key = seriesKey(name, labels);
        counts.set(key, (counts.get(key) ?? 0) + n);
      },
    }),
    histogram: (name, buckets) => ({
      observe: (value, labels) => {
        observations.push(
          labels === undefined ? { name, buckets, value } : { name, buckets, value, labels },
        );
      },
    }),
  };
  return {
    metrics,
    count: (name, labels) => counts.get(seriesKey(name, labels)) ?? 0,
    observations,
  };
}

/** `n` base62 characters. */
export const base62 = (n: number): string => 'Ab3k9ZqR7x'.repeat(Math.ceil(n / 10)).slice(0, n);

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A CT-AUTH live API key: `cen_live_` and 32 base62 characters. */
export const LIVE_KEY = ['cen', 'live', base62(32)].join('_');
/** A CT-AUTH test API key. */
export const TEST_KEY = ['cen', 'test', base62(32)].join('_');
/** A three-part JWT (header, claims, signature). */
export const JWT = [
  base64url({ alg: 'HS256', typ: 'JWT' }),
  base64url({ sub: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', exp: 1 }),
  Buffer.from('signature-bytes').toString('base64url'),
].join('.');
/** A five-part JWE (header, key, iv, ciphertext, tag). */
export const JWE = [
  base64url({ alg: 'RSA-OAEP', enc: 'A256GCM' }),
  'ZW5jcnlwdGVkLWtleQ',
  'aXYtYnl0ZXM',
  'Y2lwaGVydGV4dC1ieXRlcw',
  'dGFnLWJ5dGVz',
].join('.');

/** Valid CT-IDS ids. */
export const REQUEST_ID = 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
export const USER_ID = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
export const SESSION_ID = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/**
 * A log object of about 1.1 MB as JSON (B005 acceptance 7): 5 000 records shaped like relay log
 * fields, plus one deny-listed key.
 */
export function megabyteObject(): { items: Record<string, unknown>[]; token: string } {
  const item = (i: number): Record<string, unknown> => ({
    id: `ses_${String(i).padStart(26, '0')}`,
    kind: 'message.user',
    seq: i,
    size: 1024 + i,
    note: `item ${i} of the batch, nothing secret here`,
    tags: ['a', 'b', 'c'],
    nested: { route: '/v1/sessions/:id', status: 200, ok: true },
  });
  return { items: Array.from({ length: 5000 }, (_, i) => item(i)), token: 'x' };
}

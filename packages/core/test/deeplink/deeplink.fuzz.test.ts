/**
 * Parser fuzzing (B033, card test deeplink.fuzz.test.ts, acceptance 5): 10 000 generated strings
 * (arbitrary text, valid links with random edits, and links put together from the table's parts
 * and near misses) never make parseDeepLink throw, and it says `ok: true` only for a string the
 * table's patterns (an oracle in helpers.ts, written apart from the parser) accept, as the kind and
 * with the values they name.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildAuthCallbackUrl,
  buildBillingUrl,
  buildInviteUrl,
  buildJoinUrl,
  buildSessionUrl,
  buildShareUrl,
  parseDeepLink,
} from '../../src/index.js';
import { CODE, ORACLE, SES, STATE, TOKEN } from './helpers.js';

const VALID = [
  ...[buildJoinUrl(TOKEN), buildInviteUrl(TOKEN), buildShareUrl(TOKEN), buildBillingUrl()].flatMap(
    (pair) => [pair.web, pair.app],
  ),
  buildSessionUrl(SES).web,
  buildSessionUrl(SES, 'approval').app,
  buildSessionUrl(SES, 'queue').app,
  buildAuthCallbackUrl(CODE, STATE),
];

/** The value of a raw query parameter that appears exactly once, else undefined. */
function single(input: string, name: string): string | null | undefined {
  const mark = input.indexOf('?');
  if (mark < 0) return undefined;
  const hits = input
    .slice(mark + 1)
    .split('&')
    .filter((part) => part === name || part.startsWith(`${name}=`));
  if (hits.length !== 1) return undefined;
  const hit = hits[0] ?? '';
  return hit === name ? null : hit.slice(name.length + 1);
}

/** Parses `input`; fails the property when it throws or accepts what the oracle refuses. */
function check(input: string, accepted: { n: number }): void {
  let result: ReturnType<typeof parseDeepLink>;
  try {
    result = parseDeepLink(input);
  } catch (e) {
    throw new Error(`parseDeepLink threw for ${JSON.stringify(input)}`, { cause: e });
  }
  if (!result.ok) {
    expect(result).toEqual({ ok: false });
    return;
  }
  accepted.n++;
  const row = ORACLE.find((r) => r.re.test(input));
  expect(row, `accepted a string off the table: ${JSON.stringify(input)}`).toBeDefined();
  if (row === undefined) return;
  expect(result.kind).toBe(row.kind);
  expect(result.form).toBe(row.form);
  if (input.includes('#') || single(input, 'k') !== undefined || input.includes('&k=')) {
    throw new Error(`accepted key material: ${JSON.stringify(input)}`);
  }
  const named = row.re.exec(input)?.[1];
  switch (result.kind) {
    case 'join':
    case 'invite':
    case 'share':
      expect(result.token).toBe(named);
      break;
    case 'session':
      expect(result.sessionId).toBe(named);
      expect(result.focus === null ? undefined : result.focus).toBe(single(input, 'focus'));
      break;
    case 'auth_callback':
      expect(result.code).toBe(single(input, 'code'));
      expect(result.state).toBe(single(input, 'state'));
      expect(result.code).toMatch(/^[A-Za-z0-9._~-]{1,512}$/);
      expect(result.state).toMatch(/^[A-Za-z0-9._~-]{1,512}$/);
      break;
    case 'billing':
      break;
  }
}

/** Pieces links are made of, valid and nearly so. */
const PREFIXES = [
  'https://centcom.dev/',
  'http://centcom.dev/',
  'https://centcom.dev.evil.test/',
  'https://evil.test/',
  'https://CENTCOM.dev/',
  'centcom://',
  'centcom:/',
  'Centcom://',
  '',
];
const PATHS = ['j/', 'i/', 'g/', 's/', 'billing', 'join/', 'invite/', 'share/', 'session/'];
const BODIES = [TOKEN, TOKEN.slice(1), `${TOKEN}A`, SES, SES.toLowerCase(), 'ses_', '', '#k=a'];
const QUERIES = [
  '',
  '?',
  '?focus=approval',
  '?focus=queue',
  '?focus=other',
  '?focus=approval&focus=queue',
  `?code=${CODE}&state=${STATE}`,
  `?code=${CODE}`,
  '?k=a2V5',
  '?utm=1',
  '#k=a2V5',
  '?a=b c',
];

const EDIT_CHARS = [...'aZ09_-./:?#&=%@ \\\t+~é'];

describe('parseDeepLink under fuzzing (acceptance 5)', () => {
  it('never throws, and accepts only what the table accepts, over 10 000 strings', () => {
    const accepted = { n: 0 };
    const arbitrary = fc.oneof(
      fc.string({ maxLength: 120 }),
      fc.string({ unit: 'binary', maxLength: 120 }),
      fc.string({ unit: fc.constantFrom(...'centcom:/?#&=_-jigsbAZ09%'.split('')), maxLength: 80 }),
    );
    const edited = fc
      .tuple(
        fc.constantFrom(...VALID),
        fc.array(
          fc.tuple(
            fc.constantFrom('insert', 'delete', 'replace'),
            fc.nat(),
            fc.constantFrom(...EDIT_CHARS),
          ),
          { maxLength: 3 },
        ),
      )
      .map(([link, edits]) => {
        let out = link;
        for (const [op, at, ch] of edits) {
          const i = at % (out.length + 1);
          if (op === 'insert') out = out.slice(0, i) + ch + out.slice(i);
          else if (op === 'delete') out = out.slice(0, i) + out.slice(i + 1);
          else out = out.slice(0, i) + ch + out.slice(i + 1);
        }
        return out;
      });
    const assembled = fc
      .tuple(
        fc.constantFrom(...PREFIXES),
        fc.constantFrom(...PATHS),
        fc.constantFrom(...BODIES),
        fc.constantFrom(...QUERIES),
        fc.constantFrom(...QUERIES),
      )
      .map(([prefix, path, body, q1, q2]) => {
        const tail = q2.startsWith('?') ? `&${q2.slice(1)}` : q2;
        return path === 'billing'
          ? `${prefix}${path}${q1}${tail}`
          : `${prefix}${path}${body}${q1}${tail}`;
      });
    fc.assert(
      fc.property(fc.oneof(arbitrary, edited, assembled), (input) => {
        check(input, accepted);
      }),
      { numRuns: 10_000, seed: 0x0b033 },
    );
    // The generators reach the accepting side too, not only refusals.
    expect(accepted.n).toBeGreaterThan(500);
  });

  it('accepts every valid link exactly as the oracle reads it', () => {
    const accepted = { n: 0 };
    for (const link of VALID) check(link, accepted);
    expect(accepted.n).toBe(VALID.length);
  });
});

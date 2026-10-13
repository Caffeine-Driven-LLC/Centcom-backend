/**
 * Test helpers for the credential-leak guard (B101). Secrets are assembled at run time so the
 * repository holds no secret-shaped literal for the secret scan to flag; the contract's own
 * examples are read from the fixture file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_PATTERNS } from '../../src/secret-guard/patterns.generated.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/** The contract's pattern file. */
export const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, 'contracts/fixtures/providers/secret-patterns.json'), 'utf8'),
) as {
  patterns: { id: string; regex: string }[];
  must_match: string[];
  must_not_match: string[];
};

/** `must_match` strings with the pattern id each one should produce. */
export const EXPECTED: readonly (readonly [string, string])[] = [
  [FIXTURE.must_match[0] ?? '', 'anthropic_api_key'],
  [FIXTURE.must_match[1] ?? '', 'openai_api_key'],
  [FIXTURE.must_match[2] ?? '', 'bearer_header'],
  [FIXTURE.must_match[3] ?? '', 'aws_access_key'],
];

export const ANTHROPIC_KEY = ['sk-ant-', 'api03-', 'A'.repeat(24)].join('');
export const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
export const BEARER_LINE = [
  'Authorization: ',
  'Bearer ',
  'abcdefghijklmnopqrstuvwxyz0123456789',
].join('');
export const JWT = [
  'eyJ' + 'hbGciOiJFZERTQSJ9',
  'eyJ' + 'zdWIiOiJ1c3JfMDEifQ',
  'c2lnbmF0dXJlc2lnbmF0dXJl',
].join('.');

/** Every event fixture's frame. */
export function eventFrames(): { name: string; frame: Record<string, unknown> }[] {
  const dir = join(ROOT, 'contracts/fixtures/events');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: f,
      frame: (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { frame: Record<string, unknown> })
        .frame,
    }));
}

/** The generated pattern source, for comparing with the contract. */
export const GENERATED = GENERATED_PATTERNS;

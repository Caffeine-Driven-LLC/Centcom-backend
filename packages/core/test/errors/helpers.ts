/**
 * Test helpers for the error layer (B006): the shared contracts/ files, a problem context, and
 * secret-shaped values. Secrets are assembled at run time so the repository holds no
 * secret-shaped literal for the secret scan (B002) to flag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'contracts');

/** Parses a file under contracts/ (read-only). */
export const readContract = <T>(...parts: string[]): T =>
  JSON.parse(readFileSync(join(CONTRACTS_DIR, ...parts), 'utf8')) as T;

/** A contracts/fixtures/problem/*.json file. */
export interface ProblemFixture {
  schema: string;
  valid: boolean;
  note: string;
  data: Record<string, unknown>;
}

/** A valid CT-IDS request id (the one the contract fixtures use). */
export const REQUEST_ID = 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
/** The context most tests pass to toProblem. */
export const CTX = { requestId: REQUEST_ID } as const;

/** `n` base62 characters. */
export const base62 = (n: number): string => 'Ab3k9ZqR7x'.repeat(Math.ceil(n / 10)).slice(0, n);

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A JWT-shaped bearer credential. */
export const JWT = [
  base64url({ alg: 'HS256', typ: 'JWT' }),
  base64url({ sub: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', exp: 1_900_000_000 }),
  base62(43),
].join('.');

/** A CT-AUTH live API key. */
export const LIVE_KEY = ['cen', 'live', base62(32)].join('_');

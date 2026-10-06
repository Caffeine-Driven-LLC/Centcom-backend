/** Test helper: reads files from the shared contracts/ directory (read-only). */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', '..', 'contracts');

export type JsonObject = { [key: string]: unknown };

export const readContract = <T = JsonObject>(...parts: string[]): T =>
  JSON.parse(readFileSync(join(CONTRACTS_DIR, ...parts), 'utf8')) as T;

export const readContractText = (...parts: string[]): string => readFileSync(join(CONTRACTS_DIR, ...parts), 'utf8');

/** Every fixture file as [area, file name], sorted. */
export function fixtureFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const area of readdirSync(join(CONTRACTS_DIR, 'fixtures')).sort()) {
    for (const file of readdirSync(join(CONTRACTS_DIR, 'fixtures', area)).sort()) out.push([area, file]);
  }
  return out;
}

export interface GenericFixture {
  schema: string;
  valid: boolean;
  note?: string;
  data: unknown;
}

export interface EventFixture {
  kind: string;
  frame: JsonObject;
  secret_payload: JsonObject | null;
}

/** Deep copy for mutation in tests. */
export const clone = <T>(v: T): T => structuredClone(v);

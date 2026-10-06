// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ (contract_version 1.2.0) via packages/contracts/scripts/generate.ts (lane B003).
// Regenerate with `pnpm contracts:gen`; `pnpm contracts:check` fails when this file is stale.

/** One Ajv error from a generated validator (they stop at the first error, plus wrapper errors). */
export interface AjvErrorObject {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/** A precompiled validator: returns true when valid; when false, `errors` holds the reason. */
export interface RawValidator {
  (data: unknown): boolean;
  errors?: AjvErrorObject[] | null;
}

/** Every validator by schema key; `<key>#tolerant` exists only where an extensible enum is reachable. */
export declare const VALIDATORS: Readonly<Record<string, RawValidator>>;

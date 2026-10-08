/**
 * Workspace request bodies (B027, CT-API-WORKSPACES `WorkspaceCreate`, `WorkspaceUpdate`): the
 * name (1-60 code points after NFC, no control characters, CT-IDS), an optional slug on create,
 * and on update the name plus the fields PATCH extensions own (B034 adds `settings` this way).
 * Unknown fields are ignored (CT-VER) and never stored. A bad value is a 422 `validation_failed`
 * whose `errors[]` point at the fields; the rejected values are never echoed.
 *
 * Owns: parsing the bodies and the extension registry. Must not: accept a field no code owns.
 */
import { checkName, checkSlug, type ValidationIssue } from '@centcom/contracts';
import { validationFailed, type FieldError } from '@centcom/core';
import type { WorkspaceTx } from '@centcom/db';
import type { RequestCtx } from './service.js';

/** The detail of a 422 on a workspace body (GUIDELINES §3.4: one message table). */
export const INVALID_BODY_DETAIL = 'Some fields are not valid.';

/** A field of the PATCH body owned by another lane's code. */
export interface PatchExtension {
  /** The body field it owns, such as `settings`. */
  readonly key: string;
  /** Checks the field's value; returns it as `apply` takes it, or the issues (pointers below the field). */
  parse(value: unknown): { value: unknown; issues?: undefined } | { issues: ValidationIssue[] };
  /**
   * Applies it in the PATCH's transaction, after the ETag check; the version moves on once for
   * all. `ctx` writes audit events in that transaction. May return a step to run after the commit
   * (an announcement); it must not throw.
   */
  apply(
    tx: WorkspaceTx,
    workspaceId: string,
    value: unknown,
    ctx: RequestCtx,
  ): Promise<void> | Promise<(() => Promise<void>) | undefined>;
}

/** The PATCH extensions, by field. */
export interface PatchExtensionRegistry {
  /** Adds an extension; a TypeError for a field already owned, `name`, or not a lower-case word. */
  register(extension: PatchExtension): void;
  /** The extensions, in registration order. */
  list(): readonly PatchExtension[];
}

/** A new, empty registry. */
export function createPatchExtensionRegistry(): PatchExtensionRegistry {
  const extensions: PatchExtension[] = [];
  return {
    register(extension) {
      if (!/^[a-z][a-z0-9_]*$/.test(extension.key) || extension.key === 'name') {
        throw new TypeError(
          `registerPatchExtension: "${extension.key}" cannot be an extension field`,
        );
      }
      if (extensions.some((e) => e.key === extension.key)) {
        throw new TypeError(`registerPatchExtension: "${extension.key}" is already registered`);
      }
      extensions.push(extension);
    },
    list: () => [...extensions],
  };
}

/** A checked `WorkspaceCreate`. */
export interface CreateInput {
  name: string;
  /** The slug the caller asked for; made from the name when absent. */
  slug?: string;
}

/** A checked `WorkspaceUpdate`. */
export interface UpdateInput {
  name?: string;
  /** The extension fields present, with their parsed values, in registration order. */
  extensions: { extension: PatchExtension; value: unknown }[];
  /** The names of the fields that change (for the audit event): `name`, then the extensions'. */
  fields: string[];
}

const at = (pointer: string, issues: readonly ValidationIssue[]): FieldError[] =>
  issues.map((issue) => ({
    pointer: `${pointer}${issue.pointer}`,
    code: issue.code,
    detail: issue.detail,
  }));

/** The body as an object, or a 422. */
function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  return body as Record<string, unknown>;
}

/** Checks a `WorkspaceCreate` body: `name` required, `slug` optional; other fields ignored. */
export function parseCreate(body: unknown): CreateInput {
  const input = objectBody(body);
  const issues: FieldError[] = [];
  const name = checkName('workspaceName', input['name']);
  if (!name.ok) {
    issues.push(
      ...(input['name'] === undefined
        ? [{ pointer: '/name', code: 'required', detail: 'is required' }]
        : at('/name', name.errors)),
    );
  }
  let slug: string | undefined;
  if (input['slug'] !== undefined) {
    const checked = checkSlug(input['slug']);
    if (checked.ok) slug = checked.value;
    else issues.push(...at('/slug', checked.errors));
  }
  if (issues.length > 0 || !name.ok) throw validationFailed(issues, INVALID_BODY_DETAIL);
  return { name: name.value, ...(slug === undefined ? {} : { slug }) };
}

/**
 * Checks a `WorkspaceUpdate` body: `name` and the registered extensions' fields; anything else is
 * ignored. A body naming none of them is a 422 (the schema's `minProperties: 1`).
 */
export function parseUpdate(body: unknown, registry: PatchExtensionRegistry): UpdateInput {
  const input = objectBody(body);
  const issues: FieldError[] = [];
  const update: UpdateInput = { extensions: [], fields: [] };
  if (input['name'] !== undefined) {
    const name = checkName('workspaceName', input['name']);
    if (name.ok) {
      update.name = name.value;
      update.fields.push('name');
    } else {
      issues.push(...at('/name', name.errors));
    }
  }
  for (const extension of registry.list()) {
    const raw = input[extension.key];
    if (raw === undefined) continue;
    const parsed = extension.parse(raw);
    if (parsed.issues !== undefined) {
      issues.push(...at(`/${extension.key}`, parsed.issues));
    } else {
      update.extensions.push({ extension, value: parsed.value });
      update.fields.push(extension.key);
    }
  }
  if (issues.length > 0) throw validationFailed(issues, INVALID_BODY_DETAIL);
  if (update.fields.length === 0) {
    throw validationFailed(
      [{ pointer: '', code: 'too_few', detail: 'must name at least one field to change' }],
      INVALID_BODY_DETAIL,
    );
  }
  return update;
}

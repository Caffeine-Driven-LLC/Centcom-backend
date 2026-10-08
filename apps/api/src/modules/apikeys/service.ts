/**
 * API keys (B019, CT-AUTH, CT-API-ACCOUNTS): machine credentials of one workspace.
 *
 * - **Create** (the routes check `apikey.manage.own` first): the key is generated from the CSPRNG,
 *   returned once and stored only as sha256(pepper ‖ key) with its 12-character prefix. Its
 *   scopes must be known CT-AUTH scopes, never `admin`, held by the creator's own credential, and
 *   within the creator's role: every RBAC action a scope opens to keys must be one the creator may
 *   do. The workspace row is locked while its live keys are counted against `api_keys_max`
 *   (CT-ENTITLEMENTS; 429 `quota_exceeded` at the limit, `null` = unlimited), so concurrent
 *   creates never pass it.
 * - **Revoke**: from the next request on, the key gets 401 `token_revoked`; revoking twice is fine.
 * - **Rotate** (`rotateApiKey`, for the admin console; no public route): a replacement with the
 *   same name, scopes, mode and expiry, and the old key revoked, in one transaction.
 *
 * Every change writes its audit event (`api_key.create`, `api_key.revoke`) in its transaction.
 *
 * Owns: the rules above. Must not: store, log or return a key but in `create`'s and
 * `rotateApiKey`'s result.
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  MATRIX,
  notFound,
  SCOPES,
  validationFailed,
  WORKSPACE_ACTIONS,
  type AuditActor,
  type FieldError,
  type Page,
  type PageParams,
  type Secret,
  type WorkspaceAction,
} from '@centcom/core';
import type { ApiKeyMode } from '@centcom/db';
import type { RequestCtx } from '../workspaces/service.js';
import { generateApiKey, hashApiKey, type RandomSource } from './generate.js';
import type { ApiKeyFilter, ApiKeyRecord, ApiKeyStore } from './repo.js';

/** How many API keys a workspace may hold (CT-ENTITLEMENTS `api_keys_max`); null is unlimited. */
export interface ApiKeyLimits {
  apiKeysMax(workspaceId: string): Promise<number | null>;
}

/** Until billing exists: every workspace is on `free`, 1 key (CT-ENTITLEMENTS). */
export const FREE_API_KEY_LIMITS: ApiKeyLimits = { apiKeysMax: () => Promise.resolve(1) };

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const API_KEY_DETAILS = Object.freeze({
  notFound: 'There is no such API key.',
  invalidBody: 'Some fields are not valid.',
  unknownScope: 'A scope is not one an API key can hold.',
  beyondRights: 'An API key cannot hold a scope beyond your own rights in the workspace.',
  quota: 'The workspace has as many API keys as its plan allows; revoke one first.',
  workspaceGone: 'There is no such workspace.',
});

/** The longest name, in characters. */
export const MAX_KEY_NAME = 60;
/** Every scope a key may hold: CT-AUTH's, without the internal `admin`. */
export const API_KEY_SCOPES: readonly string[] = SCOPES.filter((scope) => scope !== 'admin');

/** A checked create request. */
export interface ApiKeyInput {
  workspaceId: string;
  name: string;
  scopes: string[];
  mode: ApiKeyMode;
  expiresAt: Date | null;
}

/** A new key: its record and, this once, the key. */
export interface CreatedApiKey {
  record: ApiKeyRecord;
  key: string;
}

/** Who creates a key: the user, the scopes their credential holds, and what their role allows. */
export interface ApiKeyCreator {
  userId: string;
  scopes: readonly string[];
  /** Whether the creator may do `action` in the key's workspace (B021 `decide`). */
  may(action: WorkspaceAction): Promise<boolean>;
}

/** Dependencies of the service. */
export interface ApiKeyServiceDeps {
  store: ApiKeyStore;
  pepper: Secret<string>;
  /** Default FREE_API_KEY_LIMITS. */
  limits?: ApiKeyLimits;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  /** Randomness for keys; default the CSPRNG. */
  random?: RandomSource;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_FIELDS = new Set(['workspace', 'name', 'scopes', 'mode', 'expires_at']);

/** The workspace actions each scope opens to an API key (B021 `apiKeyScope`). */
const ACTIONS_OF_SCOPE: ReadonlyMap<string, readonly WorkspaceAction[]> = (() => {
  const map = new Map<string, WorkspaceAction[]>();
  for (const action of WORKSPACE_ACTIONS) {
    const rule = MATRIX[action];
    if (rule.kind !== 'workspace' || rule.apiKeyScope === undefined) continue;
    map.set(rule.apiKeyScope, [...(map.get(rule.apiKeyScope) ?? []), action]);
  }
  return map;
})();

/**
 * Checks a `POST /v1/api-keys` body: 422 `validation_failed` with every shape problem, then 400
 * `invalid_scope` (pointer `/scopes/<i>`) for a scope that is unknown or `admin`.
 */
export function parseApiKeyInput(body: unknown, now: Date): ApiKeyInput {
  if (!isRecord(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const errors: FieldError[] = [];
  const { workspace, name, scopes, mode, expires_at: expiresAt } = body;
  if (typeof workspace !== 'string' || !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspace)) {
    errors.push({
      pointer: '/workspace',
      code: 'invalid_format',
      detail: 'must be a workspace id',
    });
  }
  if (typeof name !== 'string') {
    errors.push({ pointer: '/name', code: 'invalid_type', detail: 'must be a string' });
  } else if (name.trim() === '' || [...name].length > MAX_KEY_NAME || /\p{Cc}/u.test(name)) {
    errors.push({
      pointer: '/name',
      code: 'invalid_value',
      detail: `must be 1 to ${MAX_KEY_NAME} characters without control characters`,
    });
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    errors.push({ pointer: '/scopes', code: 'too_few', detail: 'must list at least one scope' });
  } else if (!scopes.every((s) => typeof s === 'string')) {
    errors.push({ pointer: '/scopes', code: 'invalid_type', detail: 'must be strings' });
  } else if (new Set(scopes).size !== scopes.length) {
    errors.push({ pointer: '/scopes', code: 'invalid_value', detail: 'must not repeat a scope' });
  }
  if (mode !== undefined && mode !== 'live' && mode !== 'test') {
    errors.push({ pointer: '/mode', code: 'invalid_value', detail: 'must be live or test' });
  }
  let expires: Date | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    expires = typeof expiresAt === 'string' ? new Date(expiresAt) : new Date(Number.NaN);
    const valid =
      typeof expiresAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(expiresAt) &&
      !Number.isNaN(expires.getTime());
    if (!valid) {
      errors.push({
        pointer: '/expires_at',
        code: 'invalid_format',
        detail: 'must be an RFC 3339 date-time',
      });
    } else if (expires.getTime() <= now.getTime()) {
      errors.push({
        pointer: '/expires_at',
        code: 'out_of_range',
        detail: 'must be in the future',
      });
    }
  }
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) {
      errors.push({
        pointer: `/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        code: 'not_allowed',
        detail: 'is not a known field',
      });
    }
  }
  if (errors.length > 0) throw validationFailed(errors, API_KEY_DETAILS.invalidBody);
  const list = scopes as string[];
  const unknown = list.flatMap((scope, i): FieldError[] =>
    API_KEY_SCOPES.includes(scope)
      ? []
      : [
          {
            pointer: `/scopes/${i}`,
            code: 'invalid_value',
            detail: 'is not a scope an API key can hold',
          },
        ],
  );
  if (unknown.length > 0) {
    throw new AppError('invalid_scope', { detail: API_KEY_DETAILS.unknownScope, errors: unknown });
  }
  return {
    workspaceId: workspace as string,
    name: (name as string).trim(),
    scopes: list,
    mode: (mode as ApiKeyMode | undefined) ?? 'live',
    expiresAt: expires,
  };
}

/** API keys. */
export class ApiKeyService {
  readonly #store: ApiKeyStore;
  readonly #pepper: Secret<string>;
  readonly #limits: ApiKeyLimits;
  readonly #now: () => number;
  readonly #random: RandomSource | undefined;

  constructor(deps: ApiKeyServiceDeps) {
    this.#store = deps.store;
    this.#pepper = deps.pepper;
    this.#limits = deps.limits ?? FREE_API_KEY_LIMITS;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random;
  }

  /** The current time. */
  now(): Date {
    return new Date(this.#now());
  }

  /** Makes a key for `creator` (see the file comment); the key is in the result, this once. */
  async create(
    input: ApiKeyInput,
    creator: ApiKeyCreator,
    ctx: RequestCtx,
  ): Promise<CreatedApiKey> {
    const beyond: FieldError[] = [];
    for (const [i, scope] of input.scopes.entries()) {
      let allowed = creator.scopes.includes(scope);
      for (const action of ACTIONS_OF_SCOPE.get(scope) ?? []) {
        if (!allowed) break;
        allowed = await creator.may(action);
      }
      if (!allowed) {
        beyond.push({
          pointer: `/scopes/${i}`,
          code: 'not_allowed',
          detail: 'is beyond your rights',
        });
      }
    }
    if (beyond.length > 0) {
      throw new AppError('invalid_scope', { detail: API_KEY_DETAILS.beyondRights, errors: beyond });
    }
    const limit = await this.#limits.apiKeysMax(input.workspaceId);
    const { key, prefix } = generateApiKey(input.mode, this.#random);
    const record = await this.#store.transaction(async (tx) => {
      if (!(await tx.lockWorkspace(input.workspaceId)))
        throw notFound(API_KEY_DETAILS.workspaceGone);
      if (limit !== null && (await tx.countLive(input.workspaceId, this.now())) >= limit) {
        throw new AppError('quota_exceeded', { detail: API_KEY_DETAILS.quota });
      }
      const created = await tx.insert({
        id: newId('key'),
        workspaceId: input.workspaceId,
        createdBy: creator.userId,
        name: input.name,
        mode: input.mode,
        keyHash: hashApiKey(key, this.#pepper),
        prefix,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      });
      await ctx.audit(tx.trx, {
        action: 'api_key.create',
        workspaceId: input.workspaceId,
        target: { type: 'api_key', id: created.id },
        meta: { scopes: input.scopes.join(' '), mode: input.mode },
      });
      return created;
    });
    return { record, key };
  }

  /** One page of keys: a workspace's (all, or one creator's), or a user's across workspaces. */
  list(filter: ApiKeyFilter, params: PageParams): Promise<Page<ApiKeyRecord>> {
    return this.#store.list(filter, params);
  }

  /** The key, of a live workspace, or null. */
  find(keyId: string): Promise<ApiKeyRecord | null> {
    return this.#store.findById(keyId);
  }

  /** Revokes the key; a revoked one stays as it is. 404 for an unknown key. */
  async revoke(keyId: string, ctx: RequestCtx): Promise<void> {
    await this.#store.transaction(async (tx) => {
      const key = await tx.lock(keyId);
      if (key === null) throw notFound(API_KEY_DETAILS.notFound);
      if (key.revokedAt !== null) return;
      await tx.revoke(keyId, this.now());
      await ctx.audit(tx.trx, {
        action: 'api_key.revoke',
        workspaceId: key.workspaceId,
        target: { type: 'api_key', id: keyId },
        meta: { reason: 'revoked' },
      });
    });
  }

  /**
   * The admin console's rotation: a replacement key with the old one's name, scopes, mode, expiry
   * and creator, and the old key revoked, in one transaction (both audited as `actor`). 404 for a
   * key that is unknown, revoked or expired.
   */
  async rotateApiKey(keyId: string, actor: AuditActor, ctx: RequestCtx): Promise<CreatedApiKey> {
    let created: CreatedApiKey | undefined;
    await this.#store.transaction(async (tx) => {
      const old = await tx.lock(keyId);
      const now = this.now();
      if (
        old === null ||
        old.revokedAt !== null ||
        (old.expiresAt !== null && old.expiresAt.getTime() <= now.getTime())
      ) {
        throw notFound(API_KEY_DETAILS.notFound);
      }
      if (!(await tx.lockWorkspace(old.workspaceId))) throw notFound(API_KEY_DETAILS.notFound);
      const { key, prefix } = generateApiKey(old.mode, this.#random);
      const record = await tx.insert({
        id: newId('key'),
        workspaceId: old.workspaceId,
        createdBy: old.createdBy,
        name: old.name,
        mode: old.mode,
        keyHash: hashApiKey(key, this.#pepper),
        prefix,
        scopes: old.scopes,
        expiresAt: old.expiresAt,
      });
      await tx.revoke(keyId, now);
      await ctx.audit(tx.trx, {
        action: 'api_key.create',
        actor,
        workspaceId: old.workspaceId,
        target: { type: 'api_key', id: record.id },
        meta: { scopes: old.scopes.join(' '), mode: old.mode },
      });
      await ctx.audit(tx.trx, {
        action: 'api_key.revoke',
        actor,
        workspaceId: old.workspaceId,
        target: { type: 'api_key', id: keyId },
        meta: { reason: 'rotated' },
      });
      created = { record, key };
    });
    if (created === undefined) throw notFound(API_KEY_DETAILS.notFound);
    return created;
  }
}

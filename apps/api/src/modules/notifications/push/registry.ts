/**
 * Push subscriptions (B064, CT-API-NOTIFY): where a user's notifications are pushed. A user has at
 * most 10; registering an endpoint or token the user already has returns that subscription (one
 * row per user and SHA-256 of the endpoint/token). The endpoint/token and the web-push keys are
 * sealed with AES-256-GCM (PUSH_ENCRYPTION_KEY, bound to the row id), opened only to send, and
 * never returned or logged.
 *
 * Input rules (422 with a pointer per field): `kind` is web_push, apns or fcm; `token` at most
 * 4096 characters; a web-push endpoint is https on a public host (SSRF guard) and needs `keys`
 * (`p256dh` a 65-byte uncompressed P-256 point, `auth` 16 bytes, base64url); an APNs token is hex;
 * an FCM token is printable ASCII; `device`, when given, is one of the caller's live devices.
 *
 * Failed sends are counted per subscription: five in a row within 24 h of the first delete it; a
 * successful send resets the count.
 *
 * Owns: the push_subscriptions rows. Must not: list another user's subscriptions, or keep an
 * endpoint, token or key in clear.
 */
import { createHash } from 'node:crypto';
import { isId, newId, type Api } from '@centcom/contracts';
import {
  AppError,
  openBody,
  sealBody,
  unavailable,
  validationFailed,
  type FieldError,
  type Secret,
} from '@centcom/core';
import { isConnectionError, type PushDatabase, type SealedColumn } from '@centcom/db';
import type { Kysely, Selectable } from 'kysely';
import type { PushSubscriptionsTable } from '@centcom/db';
import { endpointProblem, PUSH_KINDS, type PushKind, type PushTarget } from './providers.js';

/** Subscriptions a user may have. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** Longest endpoint or token. */
export const MAX_TOKEN_LENGTH = 4096;
/** Failed sends in a row that delete a subscription... */
export const FAILURES_TO_DELETE = 5;
/** ...when they all fall within this long of the first. */
export const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A registration, checked. */
export interface Registration {
  kind: PushKind;
  token: string;
  keys?: { p256dh: string; auth: string };
  device?: string;
}

/** The details of the registry's refusals (GUIDELINES §3.4). */
export const PUSH_DETAILS = Object.freeze({
  full: `A user may register at most ${MAX_SUBSCRIPTIONS_PER_USER} push subscriptions; delete one first.`,
  notFound: 'There is no such push subscription.',
} as const);

const B64URL = /^[A-Za-z0-9_-]+$/;
const APNS_TOKEN = /^[0-9A-Fa-f]{32,512}$/;
const FCM_TOKEN = /^[\x21-\x7e]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Bytes of a base64url string, or undefined. */
function b64urlBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !B64URL.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

/** A `PushSubscriptionCreate` body, checked; 422 with every bad field's pointer. */
export function parseRegistration(body: unknown): Registration {
  if (!isRecord(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const errors: FieldError[] = [];
  const kind = body['kind'];
  if (!(PUSH_KINDS as readonly unknown[]).includes(kind)) {
    errors.push({
      pointer: '/kind',
      code: 'invalid_value',
      detail: 'must be web_push, apns or fcm',
    });
  }
  const token = body['token'];
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) {
    errors.push({
      pointer: '/token',
      code: 'invalid_length',
      detail: `must be 1 to ${MAX_TOKEN_LENGTH} characters`,
    });
  } else if (kind === 'web_push') {
    const problem = endpointProblem(token);
    if (problem !== undefined)
      errors.push({ pointer: '/token', code: 'invalid_value', detail: problem });
  } else if (kind === 'apns' && !APNS_TOKEN.test(token)) {
    errors.push({
      pointer: '/token',
      code: 'invalid_format',
      detail: 'must be a hex device token',
    });
  } else if (kind === 'fcm' && !FCM_TOKEN.test(token)) {
    errors.push({
      pointer: '/token',
      code: 'invalid_format',
      detail: 'must be an FCM registration token',
    });
  }
  const keys = body['keys'];
  let checkedKeys: Registration['keys'];
  if (kind === 'web_push') {
    if (!isRecord(keys)) {
      errors.push({ pointer: '/keys', code: 'required', detail: 'is required for web_push' });
    } else {
      const p256dh = b64urlBytes(keys['p256dh']);
      if (p256dh?.length !== 65 || p256dh[0] !== 4) {
        errors.push({
          pointer: '/keys/p256dh',
          code: 'invalid_format',
          detail: 'must be an uncompressed P-256 public key (65 bytes), base64url',
        });
      }
      const auth = b64urlBytes(keys['auth']);
      if (auth?.length !== 16) {
        errors.push({
          pointer: '/keys/auth',
          code: 'invalid_format',
          detail: 'must be 16 bytes, base64url',
        });
      }
      checkedKeys = { p256dh: String(keys['p256dh']), auth: String(keys['auth']) };
    }
  } else if (keys !== undefined) {
    errors.push({ pointer: '/keys', code: 'not_allowed', detail: 'is only for web_push' });
  }
  const device = body['device'];
  if (device !== undefined && !isId('dev', device)) {
    errors.push({ pointer: '/device', code: 'invalid_format', detail: 'must be a dev_ id' });
  }
  if (errors.length > 0) throw validationFailed(errors);
  return {
    kind: kind as PushKind,
    token: token as string,
    ...(checkedKeys === undefined ? {} : { keys: checkedKeys }),
    ...(device === undefined ? {} : { device: device as string }),
  };
}

type Row = Selectable<PushSubscriptionsTable>;

/** A subscription as CT-API-NOTIFY `PushSubscription`. */
export function subscriptionView(
  row: Pick<Row, 'id' | 'kind' | 'device_id' | 'created_at'>,
): Api.PushSubscription {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.device_id === null ? {} : { device: row.device_id }),
    created_at: row.created_at.toISOString(),
  };
}

/** Runs a database step; an outage becomes a 503 without its details. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    throw unavailable(undefined, undefined, { cause: new Error('database unavailable') });
  }
}

const tokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** Push subscriptions on Postgres. */
export class PushRegistry {
  constructor(private readonly deps: { db: Kysely<PushDatabase>; key: Secret<Uint8Array> }) {}

  /**
   * Registers `input` for `userId`: the new subscription, or the user's existing one for the same
   * endpoint/token (`created` false). 409 `conflict` past 10; 422 for a device that is not the
   * user's.
   */
  async register(
    userId: string,
    input: Registration,
  ): Promise<{ subscription: Api.PushSubscription; created: boolean }> {
    const { key } = this.deps;
    const hash = tokenHash(input.token);
    return guarded(() =>
      this.deps.db.transaction().execute(async (trx) => {
        // One registration at a time per user: the count and the insert agree.
        await trx.selectFrom('users').select('id').where('id', '=', userId).forUpdate().execute();
        const existing = await trx
          .selectFrom('push_subscriptions')
          .select(['id', 'kind', 'device_id', 'created_at'])
          .where('user_id', '=', userId)
          .where('token_hash', '=', hash)
          .executeTakeFirst();
        if (existing !== undefined)
          return { subscription: subscriptionView(existing), created: false };
        if (input.device !== undefined) {
          const device = await trx
            .selectFrom('devices')
            .select('id')
            .where('id', '=', input.device)
            .where('user_id', '=', userId)
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
          if (device === undefined) {
            throw validationFailed([
              { pointer: '/device', code: 'invalid_value', detail: 'must be one of your devices' },
            ]);
          }
        }
        const counted = await trx
          .selectFrom('push_subscriptions')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow();
        if (Number(counted.n) >= MAX_SUBSCRIPTIONS_PER_USER) {
          throw new AppError('conflict', { detail: PUSH_DETAILS.full });
        }
        const id = newId('psh');
        const row = await trx
          .insertInto('push_subscriptions')
          .values({
            id,
            user_id: userId,
            kind: input.kind,
            device_id: input.device ?? null,
            token_hash: hash,
            token_enc: sealBody(key, Buffer.from(input.token, 'utf8'), `${id}:token`),
            keys_enc:
              input.keys === undefined
                ? null
                : sealBody(key, Buffer.from(JSON.stringify(input.keys), 'utf8'), `${id}:keys`),
          })
          .returning(['id', 'kind', 'device_id', 'created_at'])
          .executeTakeFirstOrThrow();
        return { subscription: subscriptionView(row), created: true };
      }),
    );
  }

  /** Deletes `userId`'s subscription `id`; false when there is none (another user's included). */
  async remove(userId: string, id: string): Promise<boolean> {
    if (!isId('psh', id)) return false;
    const result = await guarded(() =>
      this.deps.db
        .deleteFrom('push_subscriptions')
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    return Number(result.numDeletedRows) > 0;
  }

  /** `userId`'s subscriptions opened for sending (only `ids` when given); unreadable rows are skipped. */
  async targets(userId: string, ids?: readonly string[]): Promise<PushTarget[]> {
    let query = this.deps.db
      .selectFrom('push_subscriptions')
      .select(['id', 'kind', 'token_enc', 'keys_enc'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('id');
    if (ids !== undefined) {
      if (ids.length === 0) return [];
      query = query.where('id', 'in', ids);
    }
    const rows = await guarded(() => query.execute());
    const targets: PushTarget[] = [];
    for (const row of rows) {
      try {
        const token = openBody(
          this.deps.key,
          row.token_enc as SealedColumn,
          `${row.id}:token`,
        ).toString('utf8');
        const keys =
          row.keys_enc === null
            ? undefined
            : (JSON.parse(
                openBody(this.deps.key, row.keys_enc as SealedColumn, `${row.id}:keys`).toString(
                  'utf8',
                ),
              ) as { p256dh: string; auth: string });
        targets.push({
          id: row.id,
          kind: row.kind,
          token,
          ...(keys === undefined ? {} : { keys }),
        });
      } catch {
        // Sealed under another key or damaged: it cannot be sent to; leave it for the owner to delete.
      }
    }
    return targets;
  }

  /** A send succeeded: the failure count starts over. */
  async recordSuccess(id: string): Promise<void> {
    await guarded(() =>
      this.deps.db
        .updateTable('push_subscriptions')
        .set({ failures: 0, failing_since: null })
        .where('id', '=', id)
        .where('failures', '>', 0)
        .execute(),
    );
  }

  /**
   * A send failed after its retries: counts it (a new run when the last one began over 24 h ago)
   * and deletes the subscription at the fifth in a row. True when it was deleted.
   */
  async recordFailure(id: string, now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - FAILURE_WINDOW_MS);
    return guarded(async () => {
      const row = await this.deps.db
        .updateTable('push_subscriptions')
        .set((eb) => ({
          failures: eb
            .case()
            .when(eb.or([eb('failing_since', 'is', null), eb('failing_since', '<', cutoff)]))
            .then(1)
            .else(eb('failures', '+', 1))
            .end(),
          failing_since: eb
            .case()
            .when(eb.or([eb('failing_since', 'is', null), eb('failing_since', '<', cutoff)]))
            .then(now)
            .else(eb.ref('failing_since'))
            .end(),
        }))
        .where('id', '=', id)
        .returning('failures')
        .executeTakeFirst();
      if (row === undefined || row.failures < FAILURES_TO_DELETE) return false;
      await this.delete(id);
      return true;
    });
  }

  /** Deletes a subscription (the push service says it is gone). */
  async delete(id: string): Promise<void> {
    await guarded(() =>
      this.deps.db.deleteFrom('push_subscriptions').where('id', '=', id).execute(),
    );
  }
}

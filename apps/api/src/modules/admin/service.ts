/**
 * The admin API's work (B087): what each route reads or changes, and the bodies it answers with.
 *
 * - **Reads** present allowlisted fields only (types.ts). `support_ro` sees masked e-mail
 *   addresses. Sessions are metadata: never a name, frame, snapshot or key.
 * - **Writes** take the call's transaction (`tx`) and `after`, for work that must wait for the
 *   commit (announcements, a second revocation pass). Revoking or disabling an account that is
 *   active staff needs `superadmin`; staff records are `superadmin` only and never one's own.
 * - **Ports** (ports.ts) do the rest: tokens (B017), entitlements (B069), flags (B083), status
 *   (B086), invites and promotions (not built yet: 503 until wired).
 *
 * Owns: the rules above. Must not: return content, keys, tokens, secrets or payment data, or act
 * as a user (there is no impersonation, by design).
 */
import { createHash } from 'node:crypto';
import { isId } from '@centcom/contracts';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  forbidden,
  notFound,
  publishAuthRevocation,
  validationFailed,
  type Actor,
  type AuthRevocationEvent,
  type Logger,
  type PubSub,
  type SigningKeys,
} from '@centcom/core';
import type { StaffRole } from '@centcom/db';
import type { StaffMember } from './call.js';
import type {
  AdminEntitlements,
  AdminTokens,
  FlagAdminPort,
  InviteResender,
  PromotionGranter,
  StaffActor,
  StatusAdminPort,
} from './ports.js';
import { maskEmail, scrub } from './redact.js';
import type {
  AdminReader,
  AdminStore,
  AdminWriter,
  StaffAuditRecord,
  StaffRecord,
  UserRecord,
} from './repository.js';
import { roleAtLeast, type StaffDirectory } from './staff.js';
import {
  STAFF_ROLES,
  type AdminSession,
  type AdminStaff,
  type AdminUser,
  type AdminUserLookup,
  type AdminUserSummary,
  type AdminWorkspace,
  type DisableUserResult,
  type FlagChangeResult,
  type InviteResendResult,
  type PromotionResult,
  type RevokeTokensResult,
  type StaffAuditEntry,
  type StaffAuditPage,
} from './types.js';
import type { Incident } from '../status/service.js';
import type { IncidentStatus } from '@centcom/db';

/** Members a workspace view lists, at most. */
export const MAX_WORKSPACE_MEMBERS = 200;
/** Staff audit page size: default and most. */
export const STAFF_AUDIT_DEFAULT_LIMIT = 50;
export const STAFF_AUDIT_MAX_LIMIT = 100;
/** The sort staff audit cursors are bound to. */
const STAFF_AUDIT_SORT = 'staff_audit:-created_at';

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const ADMIN_DETAILS = Object.freeze({
  notFound: 'There is no such record.',
  selfStaff: 'Staff cannot change their own staff record.',
  staffTarget: 'Only a superadmin can act on a staff member’s account.',
  notWired: 'This admin action is not available yet.',
  invalidBody: 'The request body is not valid.',
  invalidQuery: 'The query is not valid.',
} as const);

/** A port the composition did not provide: 503, not a dependency failure. */
export class NotWiredError extends AppError {
  constructor() {
    super('service_unavailable', { detail: ADMIN_DETAILS.notWired });
  }
}

/** Queues work for after the call's transaction commits. */
export type AfterCommit = (task: () => Promise<void>) => void;

/** What the service needs. */
export interface AdminServiceDeps {
  store: Pick<AdminStore, 'reader'>;
  tokens: Pick<AdminTokens, 'revokeUser' | 'revokeDevice'>;
  directory: Pick<StaffDirectory, 'forget'>;
  flags: FlagAdminPort;
  status: StatusAdminPort;
  /** Signs `GET /staff-audit` cursors (B025). */
  cursorKeys: SigningKeys;
  entitlements?: AdminEntitlements;
  invites?: InviteResender;
  promotions?: PromotionGranter;
  /** Where revocations are announced for the relay; none: not announced. */
  pubsub?: Pick<PubSub, 'publish'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
}

const iso = (at: Date): string => at.toISOString();
const isoOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());
const missing = (): AppError => notFound(ADMIN_DETAILS.notFound);
const staffActor = (staff: StaffMember): StaffActor => ({ type: 'staff', id: staff.userId });
const flagActor = (staff: StaffMember): Actor => ({
  kind: 'user',
  userId: staff.userId,
  scopes: ['admin'],
});

/** A plain object holding only `allowed` keys; 422 otherwise. */
function bodyOf(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = body ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationFailed(
      [{ pointer: '', code: 'invalid_type', detail: 'must be a JSON object' }],
      ADMIN_DETAILS.invalidBody,
    );
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw validationFailed(
      unknown.slice(0, 10).map((key) => ({
        pointer: `/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        code: 'unknown_field',
        detail: 'is not a field of this request',
      })),
      ADMIN_DETAILS.invalidBody,
    );
  }
  return value as Record<string, unknown>;
}

const invalidField = (pointer: string, detail: string): AppError =>
  validationFailed([{ pointer, code: 'invalid_value', detail }], ADMIN_DETAILS.invalidBody);

/** The admin API's operations. */
export class AdminService {
  readonly #clock: () => number;

  constructor(private readonly deps: AdminServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  get #reader(): AdminReader {
    return this.deps.store.reader;
  }

  #email(email: string, viewer: StaffMember): string {
    return viewer.role === 'support_ro' ? maskEmail(email) : email;
  }

  #summary(user: UserRecord, viewer: StaffMember): AdminUserSummary {
    return {
      id: user.id,
      email: this.#email(user.email, viewer),
      display_name: user.display_name,
      status: user.status,
      created_at: iso(user.created_at),
    };
  }

  /** `GET /users/{id}`. */
  async user(id: string, viewer: StaffMember): Promise<AdminUser> {
    if (!isId('usr', id)) throw missing();
    const user = await this.#reader.user(id);
    if (user === null) throw missing();
    const [devices, memberships, staff] = await Promise.all([
      this.#reader.devices(id),
      this.#reader.memberships(id),
      this.#reader.staff(id),
    ]);
    return scrub({
      ...this.#summary(user, viewer),
      deletion_requested_at: isoOrNull(user.deletion_requested_at),
      login_disabled_at: isoOrNull(user.login_disabled_at),
      staff_role: staff === null || staff.disabled_at !== null ? null : staff.role,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        created_at: iso(d.created_at),
        last_seen_at: isoOrNull(d.last_seen_at),
        revoked_at: isoOrNull(d.revoked_at),
      })),
      memberships: memberships.map((m) => ({
        member: m.id,
        workspace: m.workspace_id,
        role: m.role,
        joined_at: iso(m.created_at),
      })),
    });
  }

  /** `GET /users?email=`: the user with that address (ignoring case), if any. */
  async lookupUser(
    email: unknown,
    viewer: StaffMember,
  ): Promise<{ body: AdminUserLookup; userId: string | null }> {
    if (typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw validationFailed(
        [{ pointer: '/query/email', code: 'invalid_format', detail: 'must be an e-mail address' }],
        ADMIN_DETAILS.invalidQuery,
      );
    }
    const user = await this.#reader.userByEmail(email);
    return {
      body: scrub({ data: user === null ? [] : [this.#summary(user, viewer)] }),
      userId: user?.id ?? null,
    };
  }

  /** `GET /workspaces/{id}`. */
  async workspace(id: string, viewer: StaffMember): Promise<AdminWorkspace> {
    if (!isId('wsp', id)) throw missing();
    const workspace = await this.#reader.workspace(id);
    if (workspace === null) throw missing();
    const [members, ent] = await Promise.all([
      this.#reader.members(id, MAX_WORKSPACE_MEMBERS),
      this.deps.entitlements?.get(id) ?? Promise.resolve(null),
    ]);
    return scrub({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      created_at: iso(workspace.created_at),
      deleted_at: isoOrNull(workspace.deleted_at),
      member_count: members.total,
      members: members.rows.map((m) => ({
        member: m.id,
        user: m.user_id,
        email: this.#email(m.email, viewer),
        display_name: m.display_name,
        role: m.role,
        joined_at: iso(m.created_at),
      })),
      members_truncated: members.total > members.rows.length,
      plan: ent?.plan ?? null,
      subscription_status: ent?.status ?? null,
      entitlements:
        ent === null
          ? null
          : {
              rev: ent.rev,
              limits: ent.limits,
              period: ent.period ?? null,
              grace_until: ent.grace_until ?? null,
            },
      usage: ent?.usage ?? null,
    });
  }

  /** `GET /sessions/{id}`: metadata only. */
  async session(id: string, reader: AdminReader = this.#reader): Promise<AdminSession> {
    if (!isId('ses', id)) throw missing();
    const s = await reader.session(id);
    if (s === null) throw missing();
    return {
      id: s.id,
      workspace: s.workspace_id,
      state: s.state,
      region: s.region,
      created_at: iso(s.created_at),
      ended_at: isoOrNull(s.ended_at),
      member_count: s.member_count,
      host_member: s.host_member,
    };
  }

  /** `GET /staff-audit`: `staff.access` events, newest first (CT-PAGE). */
  async staffAudit(query: Record<string, unknown>): Promise<StaffAuditPage> {
    const issues: { pointer: string; code: string; detail: string }[] = [];
    const { limit: rawLimit, cursor, actor, target } = query;
    let limit = STAFF_AUDIT_DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      limit = typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
      if (limit < 1 || limit > STAFF_AUDIT_MAX_LIMIT) {
        issues.push({ pointer: '/query/limit', code: 'out_of_range', detail: '1 to 100' });
      }
    }
    if (actor !== undefined && !isId('usr', actor)) {
      issues.push({ pointer: '/query/actor', code: 'invalid_format', detail: 'a usr_ id' });
    }
    if (
      target !== undefined &&
      (typeof target !== 'string' || !/^[a-z]{2,8}_[0-9A-Z]{26}$/.test(target))
    ) {
      issues.push({ pointer: '/query/target', code: 'invalid_format', detail: 'a CT-IDS id' });
    }
    if (cursor !== undefined && typeof cursor !== 'string') {
      issues.push({ pointer: '/query/cursor', code: 'invalid_format', detail: 'a cursor' });
    }
    if (issues.length > 0) throw validationFailed(issues, ADMIN_DETAILS.invalidQuery);
    const filters = {
      ...(actor === undefined ? {} : { actor: actor as string }),
      ...(target === undefined ? {} : { target: target as string }),
    };
    const filterHash = createHash('sha256').update(JSON.stringify(filters)).digest('base64url');
    const now = this.#clock();
    let after: { at: string; id: string } | undefined;
    if (typeof cursor === 'string') {
      const decoded = decodeCursor(cursor, this.deps.cursorKeys, now, {
        filterHash,
        sort: STAFF_AUDIT_SORT,
      });
      const [at, id] = decoded.k;
      if (typeof at !== 'string' || typeof id !== 'string') {
        throw new AppError('cursor_invalid', { detail: ADMIN_DETAILS.invalidQuery });
      }
      after = { at, id };
    }
    const rows = await this.#reader.staffAudit({
      limit: limit + 1,
      ...filters,
      ...(after === undefined ? {} : { after }),
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next =
      rows.length > limit && last !== undefined
        ? encodeCursor(
            { k: [iso(last.created_at), last.id], f: filterHash, s: STAFF_AUDIT_SORT },
            this.deps.cursorKeys,
            now,
          )
        : null;
    return scrub({ data: page.map(auditEntry), next_cursor: next, has_more: next !== null });
  }

  /** `POST /users/{id}/revoke-tokens`: one device, or every token of the user. */
  async revokeTokens(
    tx: AdminWriter,
    userId: string,
    body: unknown,
    staff: StaffMember,
    after: AfterCommit,
  ): Promise<RevokeTokensResult> {
    const input = bodyOf(body, ['device']);
    await this.#actOnAccount(tx, userId, staff);
    const device = input['device'];
    if (device !== undefined) {
      if (!isId('dev', device)) throw invalidField('/device', 'must be a dev_ id');
      const devices = await tx.devices(userId);
      if (!devices.some((d) => d.id === device)) throw missing();
      await this.deps.tokens.revokeDevice(device);
      after(() =>
        this.#announce({ type: 'device.revoked', user: userId, dev: device, at: this.#now() }),
      );
      return { user: userId, device, revoked_count: null };
    }
    const revoked = await this.deps.tokens.revokeUser(userId);
    after(() => this.#announce({ type: 'user.tokens_revoked', user: userId, at: this.#now() }));
    return { user: userId, device: null, revoked_count: revoked };
  }

  /** `POST /users/{id}/disable`: no more sign-ins or refreshes, and every token revoked. */
  async disableUser(
    tx: AdminWriter,
    userId: string,
    staff: StaffMember,
    after: AfterCommit,
  ): Promise<DisableUserResult> {
    await this.#actOnAccount(tx, userId, staff);
    const disabledAt = await tx.disableLogin(userId, new Date(this.#clock()));
    if (disabledAt === null) throw missing();
    const revoked = await this.deps.tokens.revokeUser(userId);
    after(async () => {
      // Tokens issued between the first pass and the commit (the gate could not see it yet).
      await this.deps.tokens.revokeUser(userId);
      await this.#announce({ type: 'user.tokens_revoked', user: userId, at: this.#now() });
    });
    return { user: userId, login_disabled_at: iso(disabledAt), revoked_count: revoked };
  }

  /** `POST /sessions/{id}/end`: marks the session ended (metadata; the relay acts on its own). */
  async endSession(tx: AdminWriter, id: string): Promise<AdminSession> {
    if (!isId('ses', id)) throw missing();
    if (!(await tx.endSession(id, new Date(this.#clock())))) throw missing();
    return this.session(id, tx);
  }

  /** `POST /invites/{id}/resend`. */
  async resendInvite(id: string, staff: StaffMember): Promise<InviteResendResult> {
    if (this.deps.invites === undefined) throw new NotWiredError();
    if (!isId('inv', id)) throw missing();
    const result = await this.deps.invites.resend(id, staffActor(staff));
    return scrub({
      invite: result.invite,
      workspace: result.workspace,
      expires_at: result.expires_at,
    });
  }

  /** `POST /workspaces/{id}/promotions` (B079's `grantPromotion`). */
  async grantPromotion(
    workspaceId: string,
    body: unknown,
    staff: StaffMember,
  ): Promise<PromotionResult> {
    if (this.deps.promotions === undefined) throw new NotWiredError();
    if (!isId('wsp', workspaceId)) throw missing();
    const code = bodyOf(body, ['promotion_code_id'])['promotion_code_id'];
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
      throw invalidField('/promotion_code_id', 'must be a promotion code id');
    }
    const subscription = await this.deps.promotions.grantPromotion(
      workspaceId,
      code,
      staffActor(staff),
    );
    return scrub({ workspace: workspaceId, subscription });
  }

  /** `PUT /flags/{key}` (B083's FlagAdmin; it audits the change as `flag.set` too). */
  async putFlag(key: string, body: unknown, staff: StaffMember): Promise<FlagChangeResult> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidField('', 'must be a flag definition');
    }
    const def = body as Record<string, unknown>;
    if (def['key'] !== undefined && def['key'] !== key) {
      throw invalidField('/key', 'must match the key in the path');
    }
    const { rev } = await this.deps.flags.setFlag({ ...def, key }, flagActor(staff));
    return { key, rev };
  }

  /** `DELETE /flags/{key}`. */
  async deleteFlag(key: string, staff: StaffMember): Promise<FlagChangeResult> {
    const { rev } = await this.deps.flags.deleteFlag(key, flagActor(staff));
    return { key, rev };
  }

  /** `POST /incidents` (B086's StatusAdmin). */
  async createIncident(body: unknown): Promise<Incident> {
    const input = bodyOf(body, ['title', 'component_ids', 'status']);
    return this.deps.status.createIncident({
      title: input['title'] as string,
      component_ids: input['component_ids'] as string[],
      status: input['status'] as IncidentStatus,
    });
  }

  /** `POST /incidents/{id}/updates`. */
  async addIncidentUpdate(id: string, body: unknown): Promise<Incident> {
    if (!isId('inc', id)) throw missing();
    const input = bodyOf(body, ['text', 'status']);
    const status = input['status'] as IncidentStatus | undefined;
    return this.deps.status.addIncidentUpdate(id, input['text'] as string, status);
  }

  /** `PUT /staff/{userId}`: adds or changes a staff member (superadmin; never oneself). */
  async putStaff(
    tx: AdminWriter,
    userId: string,
    body: unknown,
    staff: StaffMember,
    after: AfterCommit,
  ): Promise<AdminStaff> {
    if (userId === staff.userId) throw forbidden(ADMIN_DETAILS.selfStaff);
    if (!isId('usr', userId)) throw missing();
    const role = bodyOf(body, ['role'])['role'];
    if (typeof role !== 'string' || !(STAFF_ROLES as readonly string[]).includes(role)) {
      throw invalidField('/role', 'must be support_ro, support_rw or superadmin');
    }
    if ((await tx.user(userId)) === null) throw missing();
    const record = await tx.putStaff(
      userId,
      role as StaffRole,
      staff.userId,
      new Date(this.#clock()),
    );
    after(() => Promise.resolve(this.deps.directory.forget(userId)));
    return staffBody(record);
  }

  /** `DELETE /staff/{userId}`: disables a staff member (superadmin; never oneself). */
  async disableStaff(
    tx: AdminWriter,
    userId: string,
    staff: StaffMember,
    after: AfterCommit,
  ): Promise<AdminStaff> {
    if (userId === staff.userId) throw forbidden(ADMIN_DETAILS.selfStaff);
    if (!isId('usr', userId)) throw missing();
    const record = await tx.disableStaff(userId, new Date(this.#clock()));
    if (record === null) throw missing();
    after(() => Promise.resolve(this.deps.directory.forget(userId)));
    return staffBody(record);
  }

  /** 404 for an unknown user; 403 unless a superadmin, for an account that is active staff. */
  async #actOnAccount(tx: AdminWriter, userId: string, staff: StaffMember): Promise<void> {
    if (!isId('usr', userId) || (await tx.user(userId)) === null) throw missing();
    const target = await tx.staff(userId);
    if (target !== null && target.disabled_at === null && !roleAtLeast(staff.role, 'superadmin')) {
      throw forbidden(ADMIN_DETAILS.staffTarget);
    }
  }

  #now(): string {
    return new Date(this.#clock()).toISOString();
  }

  /** Announces a revocation; a failure is logged (the relay also checks on its own). */
  async #announce(event: AuthRevocationEvent): Promise<void> {
    if (this.deps.pubsub === undefined) return;
    try {
      await publishAuthRevocation(this.deps.pubsub, event);
    } catch (err) {
      this.deps.logger?.warn(
        { type: event.type, err: { name: err instanceof Error ? err.name : 'Error' } },
        'admin.revocation_announce_failed',
      );
    }
  }
}

const staffBody = (r: StaffRecord): AdminStaff => ({
  user: r.user_id,
  role: r.role,
  added_by: r.added_by,
  added_at: iso(r.added_at),
  disabled_at: isoOrNull(r.disabled_at),
});

const ACTOR_KINDS: ReadonlySet<string> = new Set(['staff', 'user', 'system']);

function auditEntry(r: StaffAuditRecord): StaffAuditEntry {
  const meta = r.meta;
  const text = (key: string): string | null => {
    const value = meta[key];
    return typeof value === 'string' ? value : null;
  };
  const status = meta['status'];
  return {
    id: r.id,
    at: iso(r.created_at),
    actor: {
      type: (ACTOR_KINDS.has(r.actor_type)
        ? r.actor_type
        : 'system') as StaffAuditEntry['actor']['type'],
      id: r.actor_id,
    },
    outcome: r.outcome,
    method: text('method') ?? '',
    route: text('route') ?? '',
    status: typeof status === 'number' ? status : 0,
    code: text('code'),
    target:
      r.target_type === null || r.target_id === null
        ? null
        : { type: r.target_type, id: r.target_id },
    flag: text('flag'),
    reason: r.reason,
    ticket: r.ticket,
  };
}

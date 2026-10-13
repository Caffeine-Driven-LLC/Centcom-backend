/**
 * Session invites (B105, CT-API-SESSIONS / CT-API-WORKSPACES, ADR 0002): one person into ONE
 * session, as editor or viewer, without workspace membership and without a seat.
 *
 * - **Create** (the host: the routes check): a 160-bit token, only its sha256 stored; expiry 60 s
 *   to 7 days (default 1 day); bound to an address or a link. Needs the session's workspace to
 *   have `relay_access` (402-style `entitlement_required`); asks for no seat. One pending invite
 *   per address per session (409). E-mail invites go through B032 as `workspace_invite` with the
 *   session's name where the workspace's would be; a mail that cannot be queued is logged and
 *   counted, and the invite stands.
 * - **Preview / accept** by token, as for workspace invites. Accepting writes the grant
 *   (`accepted_by`) and answers `{session, role, workspace}`; no membership, no seat. The signed-in
 *   user must hold the bound address (403). Accepting twice answers the same grant.
 * - **Revoke** (the host): the grant and the key bundle go; the relay's live membership read and
 *   the join route both stop honouring it.
 * - **Key bundle**: the host stores one, the user who accepted fetches it once.
 *
 * Owns: these rules. Must not: store, log or return a token (but in the create response and the
 * e-mail), use a seat, or reveal whether an address belongs to a user.
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  conflict,
  forbidden,
  noopMetrics,
  validationFailed,
  type AuditEmitter,
  type EmailService,
  type FieldError,
  type Logger,
  type Metrics,
  type Page,
  type PageParams,
} from '@centcom/core';
import {
  sessionInviteStatus,
  type SessionInviteRecord,
  type SessionInviteRole,
  type SessionInviteStore,
} from '@centcom/db';
import type { CheckResult } from '../entitlements/enforcement.js';
import { checkEmail } from '../users/index.js';
import { INVITE_DETAILS, KEY_BUNDLE_AFTER_ACCEPT_MS } from './service.js';
import type { InviteUrlBuilder } from './ports.js';
import { sessionInviteAuditEvent, type SessionInviteAuditAction } from './session-invite-audit.js';
import { hashInviteToken, isInviteToken, newInviteToken } from './tokens.js';

/** The expiry a session invite may ask for, in seconds. */
export const SESSION_INVITE_MIN_TTL_S = 60;
export const SESSION_INVITE_MAX_TTL_S = 7 * 24 * 60 * 60;
export const SESSION_INVITE_DEFAULT_TTL_S = 24 * 60 * 60;

/** A checked `SessionInviteCreate`. */
export interface SessionInviteInput {
  email?: string;
  role: SessionInviteRole;
  expiresInS: number;
  shareHistory: boolean;
}

/** Checks a `SessionInviteCreate` body (422 on a bad field; unknown fields are ignored). */
export function parseSessionInviteCreate(body: unknown): SessionInviteInput {
  const input: Record<string, unknown> =
    body === undefined || body === null
      ? {}
      : typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : (() => {
            throw validationFailed([
              { pointer: '', code: 'invalid_type', detail: 'must be an object' },
            ]);
          })();
  const issues: FieldError[] = [];
  const out: SessionInviteInput = {
    role: 'editor',
    expiresInS: SESSION_INVITE_DEFAULT_TTL_S,
    shareHistory: true,
  };
  if (input['email'] !== undefined) {
    const email = checkEmail(input['email'], '/email');
    if (email.value === undefined) issues.push(...email.issues);
    else out.email = email.value;
  }
  const role = input['role'];
  if (role !== undefined) {
    if (role === 'editor' || role === 'viewer') out.role = role;
    else
      issues.push({ pointer: '/role', code: 'invalid_value', detail: 'must be editor or viewer' });
  }
  const ttl = input['expires_in_s'];
  if (ttl !== undefined) {
    if (
      typeof ttl === 'number' &&
      Number.isInteger(ttl) &&
      ttl >= SESSION_INVITE_MIN_TTL_S &&
      ttl <= SESSION_INVITE_MAX_TTL_S
    ) {
      out.expiresInS = ttl;
    } else {
      issues.push({
        pointer: '/expires_in_s',
        code: 'out_of_range',
        detail: `must be a whole number from ${SESSION_INVITE_MIN_TTL_S} to ${SESSION_INVITE_MAX_TTL_S}`,
      });
    }
  }
  const share = input['share_history'];
  if (share !== undefined) {
    if (typeof share === 'boolean') out.shareHistory = share;
    else
      issues.push({
        pointer: '/share_history',
        code: 'invalid_type',
        detail: 'must be true or false',
      });
  }
  if (issues.length > 0) throw validationFailed(issues, 'Some fields are not valid.');
  return out;
}

/** The session invite's own refusals (GUIDELINES section 3.4). */
export const SESSION_INVITE_DETAILS = Object.freeze({
  over: 'That session has ended.',
  noRelay: 'This workspace’s plan does not include sessions over the relay.',
  unavailable: 'Plan limits cannot be checked right now. Try again shortly.',
  pendingExists: 'That address already has a pending invite to this session.',
} as const);

/** What a session invite preview shows. */
export interface SessionInvitePreview {
  sessionName: string;
  workspaceName: string;
  inviterName: string;
  role: SessionInviteRole;
  expiresAt: Date;
  hasKeyBundle: boolean;
}

export interface SessionInviteServiceOptions {
  store: SessionInviteStore;
  urls: InviteUrlBuilder;
  email: Pick<EmailService, 'send'>;
  /** B080's check, for `relay_access`. */
  entitlements: {
    check(workspaceId: string, key: 'relay_access'): Promise<CheckResult>;
  };
  /** Writes `invite.*` audit events (kind `session`); without it only the log lines are written. */
  audit?: Pick<AuditEmitter, 'emitDetached'>;
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

function unusable(invite: SessionInviteRecord, now: Date): AppError | null {
  switch (sessionInviteStatus(invite, now)) {
    case 'revoked':
      return new AppError('invite_revoked', { detail: INVITE_DETAILS.revoked });
    case 'expired':
      return new AppError('invite_expired', { detail: INVITE_DETAILS.expired });
    case 'accepted':
      return new AppError('gone', { detail: INVITE_DETAILS.used });
    default:
      return null;
  }
}

export class SessionInviteService {
  readonly #o: SessionInviteServiceOptions;
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(options: SessionInviteServiceOptions) {
    this.#o = options;
    this.#clock = options.clock ?? Date.now;
    this.#metrics = options.metrics ?? noopMetrics;
  }

  #now(): Date {
    return new Date(this.#clock());
  }

  /** Creates an invite to `session` by `creatorId` (already checked to be its host). */
  async create(
    session: { id: string; workspaceId: string | null; name: string; state: string },
    creatorId: string,
    inviterName: string,
    input: SessionInviteInput,
  ): Promise<{ invite: SessionInviteRecord; token: string; url: string }> {
    if (session.state === 'ended' || session.state === 'expired') {
      throw new AppError('session_ended', { detail: SESSION_INVITE_DETAILS.over });
    }
    if (session.workspaceId !== null) {
      let relay: CheckResult;
      try {
        relay = await this.#o.entitlements.check(session.workspaceId, 'relay_access');
      } catch {
        throw new AppError('service_unavailable', {
          detail: SESSION_INVITE_DETAILS.unavailable,
          retryAfterS: 5,
        });
      }
      if (!relay.allowed) {
        throw new AppError('entitlement_required', { detail: SESSION_INVITE_DETAILS.noRelay });
      }
    }
    const now = this.#now();
    const { token, hash } = newInviteToken();
    const invite = await this.#o.store.insert(
      {
        id: newId('inv'),
        sessionId: session.id,
        workspaceId: session.workspaceId,
        email: input.email ?? null,
        role: input.role,
        tokenHash: hash,
        createdBy: creatorId,
        expiresAt: new Date(now.getTime() + input.expiresInS * 1000),
        shareHistory: input.shareHistory,
      },
      now,
    );
    if (invite === null) throw conflict(SESSION_INVITE_DETAILS.pendingExists);
    const url = this.#o.urls.inviteUrl(token);
    if (input.email !== undefined)
      await this.#mail(invite, input.email, session.name, inviterName, url);
    this.#o.logger?.info(
      { invite_id: invite.id, session_id: session.id },
      'session_invite.created',
    );
    this.#audit('invite.create', invite, creatorId);
    return { invite, token, url };
  }

  async #mail(
    invite: SessionInviteRecord,
    email: string,
    sessionName: string,
    inviterName: string,
    url: string,
  ): Promise<void> {
    try {
      await this.#o.email.send(
        'session_invite',
        email,
        { inviterName, sessionName, role: invite.role, url, expiresAt: invite.expiresAt },
        { idempotencyKey: invite.id },
      );
    } catch (err) {
      this.#metrics.counter('invite_mail_failures_total').inc();
      this.#o.logger?.error(
        { invite_id: invite.id, error_code: (err as { code?: unknown }).code ?? 'unknown' },
        'session_invite.mail_failed',
      );
    }
  }

  /** The public view, or null when the token is not a session invite's (the caller tries workspace invites). */
  async preview(token: unknown): Promise<SessionInvitePreview | null> {
    if (!isInviteToken(token)) return null;
    const row = await this.#o.store.preview(hashInviteToken(token));
    if (row === null) return null;
    const refused = unusable(row.invite, this.#now());
    if (refused !== null) throw refused;
    if (row.sessionState === 'ended' || row.sessionState === 'expired') {
      throw new AppError('gone', { detail: SESSION_INVITE_DETAILS.over });
    }
    return {
      sessionName: row.sessionName,
      workspaceName: row.workspaceName,
      inviterName: row.inviterName,
      role: row.invite.role,
      expiresAt: row.invite.expiresAt,
      hasKeyBundle: row.invite.hasKeyBundle,
    };
  }

  /** Accepts for `userId`; null when the token is not a session invite's. */
  async accept(
    token: unknown,
    userId: string,
  ): Promise<{ sessionId: string; role: SessionInviteRole; workspaceId: string | null } | null> {
    if (!isInviteToken(token)) return null;
    const now = this.#now();
    const accepted = await this.#o.store.accept(
      hashInviteToken(token),
      userId,
      now,
      new Date(now.getTime() + KEY_BUNDLE_AFTER_ACCEPT_MS),
      (invite, userEmail) => {
        if (sessionInviteStatus(invite, now) === 'accepted' && invite.acceptedBy === userId) {
          return Promise.resolve();
        }
        const refused = unusable(invite, now);
        if (refused !== null) return Promise.reject(refused);
        if (invite.email !== null && userEmail !== invite.email) {
          return Promise.reject(forbidden(INVITE_DETAILS.otherAddress));
        }
        return Promise.resolve();
      },
    );
    if (accepted === null) return null;
    if (accepted.kind === 'accepted') {
      this.#metrics.counter('invites_accepted_total').inc();
      this.#o.logger?.info({ session_id: accepted.invite.sessionId }, 'session_invite.accepted');
      this.#audit('invite.accept', accepted.invite, userId);
    }
    return {
      sessionId: accepted.invite.sessionId,
      role: accepted.invite.role,
      workspaceId: accepted.invite.workspaceId,
    };
  }

  list(sessionId: string, params: PageParams): Promise<Page<SessionInviteRecord>> {
    return this.#o.store.listPending(sessionId, this.#now(), params);
  }

  find(inviteId: string): Promise<SessionInviteRecord | null> {
    return this.#o.store.findById(inviteId);
  }

  /** Revokes (the host: the routes check); 410 for one already revoked. An accepted invite's grant ends. */
  async revoke(invite: SessionInviteRecord, actorUserId?: string): Promise<void> {
    if (!(await this.#o.store.revoke(invite.id, this.#now()))) {
      throw new AppError('invite_revoked', { detail: INVITE_DETAILS.revoked });
    }
    this.#audit('invite.revoke', invite, actorUserId ?? invite.createdBy);
  }

  /** One audit event, in the background (a failed write never fails the request). */
  #audit(action: SessionInviteAuditAction, invite: SessionInviteRecord, actorUserId: string): void {
    try {
      this.#o.audit?.emitDetached(sessionInviteAuditEvent(action, invite, actorUserId));
    } catch (err) {
      this.#o.logger?.warn(
        { invite_id: invite.id, error: err instanceof Error ? err.name : 'unknown' },
        'session_invite.audit_failed',
      );
    }
  }

  /** The live grant of `userId` to `sessionId`. */
  grantFor(sessionId: string, userId: string): Promise<{ role: SessionInviteRole } | null> {
    return this.#o.store.grantFor(sessionId, userId);
  }

  /** Stores the sealed key bundle (the host: the routes check). */
  async putKeyBundle(invite: SessionInviteRecord, bundle: Buffer): Promise<void> {
    const now = this.#now();
    const status = sessionInviteStatus(invite, now);
    if (status === 'accepted') {
      if (invite.acceptedAt === null) throw new AppError('gone', { detail: INVITE_DETAILS.used });
      const until = new Date(invite.acceptedAt.getTime() + KEY_BUNDLE_AFTER_ACCEPT_MS);
      if (until.getTime() <= now.getTime())
        throw new AppError('gone', { detail: INVITE_DETAILS.used });
      await this.#o.store.putKeyBundle(invite.id, bundle, until);
      return;
    }
    const refused = unusable(invite, now);
    if (refused !== null) throw refused;
    await this.#o.store.putKeyBundle(invite.id, bundle, invite.expiresAt);
  }

  /** The bundle, once, for the user who accepted; null when the token is not a session invite's. */
  async takeKeyBundle(token: unknown, userId: string): Promise<Buffer | null> {
    if (!isInviteToken(token)) return null;
    const row = await this.#o.store.preview(hashInviteToken(token));
    if (row === null) return null;
    if (row.invite.acceptedBy !== userId) throw forbidden(INVITE_DETAILS.notYours);
    const bundle = await this.#o.store.takeKeyBundle(row.invite.id, userId, this.#now());
    if (bundle === null) throw new AppError('gone', { detail: INVITE_DETAILS.bundleGone });
    return bundle;
  }
}

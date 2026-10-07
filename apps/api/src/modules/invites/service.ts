/**
 * Workspace invites (B029, CT-API-WORKSPACES).
 *
 * - **Create** (admin+, the routes check): a 160-bit token, of which only the sha256 is stored;
 *   expiry after 7 days; bound to the invitee's address, or a link. One pending invite per address
 *   (409; an address that is already a member: 409 `member_exists`). The seat gate is asked first
 *   (fail closed). E-mail invites are queued through B032 (`workspace_invite`) after the commit;
 *   a mail that cannot be queued is logged and counted, and the invite stands.
 * - **Preview** (public): workspace name, inviter, role, expiry, whether a key bundle waits; 404
 *   for an unknown token, 410 for an expired, revoked or used one.
 * - **Accept**: locks the invite row, checks the address binding (403), locks the workspace row,
 *   marks the invite accepted, asks the seat gate and adds the member, in one transaction: two
 *   accepts for the last seat cannot both succeed, and a refusal leaves the invite pending.
 *   Accepting twice returns the same membership to the same user; another user gets 410.
 * - **Revoke** (admin+): 204, then every use is a 410 and the key bundle is gone.
 * - **Key bundle:** a session host of the workspace stores one (opaque bytes); the user who
 *   accepted fetches it once, after which it is gone (410). It also goes on revocation, expiry,
 *   or 15 minutes after acceptance (the expiry job).
 *
 * Owns: the rules above. Must not: store, log or return a token (but in the create response and
 * the e-mail), or reveal whether an address belongs to a user.
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  conflict,
  forbidden,
  noopMetrics,
  type EmailService,
  type Logger,
  type Metrics,
  type Page,
  type PageParams,
} from '@centcom/core';
import { inviteStatus, type InviteRecord, type InviteStore, type MemberRecord } from '@centcom/db';
import type { MembershipService } from '../members/service.js';
import type { RequestCtx } from '../workspaces/service.js';
import type { InviteInput } from './input.js';
import type { InviteUrlBuilder, SeatGate } from './ports.js';
import { hashInviteToken, isInviteToken, newInviteToken } from './tokens.js';

/** How long an invite lasts. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a key bundle waits for its invitee after acceptance. */
export const KEY_BUNDLE_AFTER_ACCEPT_MS = 15 * 60 * 1000;

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const INVITE_DETAILS = Object.freeze({
  unknown: 'There is no such invite.',
  expired: 'This invite has expired; ask for a new one.',
  revoked: 'This invite was revoked.',
  used: 'This invite has been used.',
  otherAddress: 'This invite is for another e-mail address.',
  pendingExists: 'That address already has a pending invite.',
  alreadyMember: 'That address already belongs to a member.',
  hostOnly: 'Only a host of one of the workspace’s sessions can store a key bundle.',
  bundleGone: 'The key bundle is gone; ask a key holder for the keys.',
  notYours: 'Only the user who accepted this invite can fetch its key bundle.',
} as const);

/** What a request lends the service: audit events in a transaction, and the seat gate. */
export interface InviteCtx extends RequestCtx {
  seatGate: SeatGate;
}

/** What a preview shows (CT-API-WORKSPACES `InvitePreview`). */
export interface InvitePreview {
  workspaceName: string;
  inviterName: string;
  role: InviteRecord['role'];
  expiresAt: Date;
  hasKeyBundle: boolean;
}

/** Options for InviteService. */
export interface InviteServiceOptions {
  store: InviteStore;
  members: MembershipService;
  urls: InviteUrlBuilder;
  /** B032's e-mail service (queues `workspace_invite`). */
  email: Pick<EmailService, 'send'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Writes `invite.*` lines (ids only). */
  logger?: Logger;
  /** Receives `invite_mail_failures_total` and `invites_accepted_total`. */
  metrics?: Metrics;
}

const unknownInvite = (): AppError =>
  new AppError('invite_invalid', { detail: INVITE_DETAILS.unknown });

/** The 410 (or 404) a used-up invite answers with. */
function unusable(invite: InviteRecord, now: Date): AppError | null {
  switch (inviteStatus(invite, now)) {
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

/** Invites. */
export class InviteService {
  readonly #o: InviteServiceOptions;
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(options: InviteServiceOptions) {
    this.#o = options;
    this.#clock = options.clock ?? Date.now;
    this.#metrics = options.metrics ?? noopMetrics;
  }

  #now(): Date {
    return new Date(this.#clock());
  }

  /** Creates an invite to `workspaceId` by `creatorId`; returns it with its token and link. */
  async create(
    workspaceId: string,
    creatorId: string,
    input: InviteInput,
    ctx: InviteCtx,
  ): Promise<{ invite: InviteRecord; token: string; url: string }> {
    const now = this.#now();
    const id = newId('inv');
    const { token, hash } = newInviteToken();
    const email = input.email ?? null;
    const invite = await this.#o.store.transaction(async (tx) => {
      await ctx.seatGate.assertCanAdd(tx.trx, workspaceId);
      if (email !== null) {
        if (await tx.isMemberEmail(workspaceId, email)) {
          throw new AppError('member_exists', { detail: INVITE_DETAILS.alreadyMember });
        }
        await tx.expireLapsed(workspaceId, email, now);
      }
      const inserted = await tx.insert({
        id,
        workspaceId,
        email,
        role: input.role,
        tokenHash: hash,
        createdBy: creatorId,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        shareHistory: input.shareHistory,
      });
      if (inserted === null) throw conflict(INVITE_DETAILS.pendingExists);
      await ctx.audit(tx.trx, {
        action: 'invite.create',
        workspaceId,
        target: { type: 'invite', id },
        meta: { role: input.role, kind: email === null ? 'link' : 'email' },
      });
      return inserted;
    });
    const url = this.#o.urls.inviteUrl(token);
    if (email !== null) await this.#mail(invite, email, hash, url);
    this.#o.logger?.info({ invite_id: id, workspace_id: workspaceId }, 'invite.created');
    return { invite, token, url };
  }

  /** Queues the invite e-mail; a failure is logged and counted, never thrown. */
  async #mail(invite: InviteRecord, email: string, hash: Buffer, url: string): Promise<void> {
    try {
      const names = await this.#o.store.preview(hash);
      if (names === null) return;
      await this.#o.email.send(
        'workspace_invite',
        email,
        {
          inviterName: names.inviterName,
          workspaceName: names.workspaceName,
          url,
          expiresAt: invite.expiresAt,
        },
        { idempotencyKey: invite.id },
      );
    } catch (err) {
      this.#metrics.counter('invite_mail_failures_total').inc();
      this.#o.logger?.error(
        { invite_id: invite.id, error_code: (err as { code?: unknown }).code ?? 'unknown' },
        'invite.mail_failed',
      );
    }
  }

  /** The public view of an invite: 404 for an unknown token, 410 for one that cannot be used. */
  async preview(token: unknown): Promise<InvitePreview> {
    if (!isInviteToken(token)) throw unknownInvite();
    const row = await this.#o.store.preview(hashInviteToken(token));
    if (row === null) throw unknownInvite();
    const refused = unusable(row.invite, this.#now());
    if (refused !== null) throw refused;
    return {
      workspaceName: row.workspaceName,
      inviterName: row.inviterName,
      role: row.invite.role,
      expiresAt: row.invite.expiresAt,
      hasKeyBundle: row.invite.hasKeyBundle,
    };
  }

  /** Accepts the invite for `userId`; returns the membership and its workspace. */
  async accept(
    token: unknown,
    userId: string,
    ctx: InviteCtx,
  ): Promise<{ member: MemberRecord; workspaceId: string }> {
    if (!isInviteToken(token)) throw unknownInvite();
    const now = this.#now();
    const accepted = await this.#o.store.transaction(async (tx) => {
      const invite = await tx.lockByToken(hashInviteToken(token));
      if (invite === null) throw unknownInvite();
      if (inviteStatus(invite, now) === 'accepted' && invite.acceptedBy === userId) {
        // The same user again: the same membership (idempotent), while they still have it.
        const member = await tx.members.lockMemberOf(invite.workspaceId, userId);
        if (member === null) throw new AppError('gone', { detail: INVITE_DETAILS.used });
        return { member, workspaceId: invite.workspaceId, again: true };
      }
      const refused = unusable(invite, now);
      if (refused !== null) throw refused;
      if (invite.email !== null && (await tx.emailOf(userId)) !== invite.email) {
        throw forbidden(INVITE_DETAILS.otherAddress);
      }
      // Members are added one at a time per workspace: the seat count holds.
      if (!(await tx.members.lockWorkspace(invite.workspaceId))) throw unknownInvite();
      if ((await tx.members.lockMemberOf(invite.workspaceId, userId)) !== null) {
        throw new AppError('member_exists', { detail: INVITE_DETAILS.alreadyMember });
      }
      // Marked before the seat check, so a gate that counts pending invites as reserved seats
      // (B030) does not count this one as well as the member it becomes; a refusal rolls it back.
      await tx.markAccepted(
        invite.id,
        userId,
        now,
        new Date(now.getTime() + KEY_BUNDLE_AFTER_ACCEPT_MS),
      );
      await ctx.seatGate.assertCanAdd(tx.trx, invite.workspaceId);
      const member = await this.#o.members.add(
        tx.members,
        invite.workspaceId,
        userId,
        invite.role,
        ctx,
        'invite',
      );
      await ctx.audit(tx.trx, {
        action: 'invite.accept',
        workspaceId: invite.workspaceId,
        target: { type: 'invite', id: invite.id },
        meta: { user_id: userId, role: invite.role },
      });
      return { member, workspaceId: invite.workspaceId, again: false };
    });
    if (!accepted.again) {
      this.#metrics.counter('invites_accepted_total').inc();
      this.#o.logger?.info(
        { workspace_id: accepted.workspaceId, member_id: accepted.member.id },
        'invite.accepted',
      );
    }
    return { member: accepted.member, workspaceId: accepted.workspaceId };
  }

  /** One page of the workspace's pending invites. */
  list(workspaceId: string, params: PageParams): Promise<Page<InviteRecord>> {
    return this.#o.store.listPending(workspaceId, this.#now(), params);
  }

  /** The invite, whatever its status, or null. */
  find(inviteId: string): Promise<InviteRecord | null> {
    return this.#o.store.findById(inviteId);
  }

  /** Revokes a pending invite (admin+: the routes check); 410 for one already used up. */
  async revoke(inviteId: string, ctx: InviteCtx): Promise<void> {
    const now = this.#now();
    await this.#o.store.transaction(async (tx) => {
      const invite = await tx.lockById(inviteId);
      if (invite === null) throw unknownInvite();
      const refused = unusable(invite, now);
      if (refused !== null) throw refused;
      await tx.markRevoked(inviteId, now);
      await ctx.audit(tx.trx, {
        action: 'invite.revoke',
        workspaceId: invite.workspaceId,
        target: { type: 'invite', id: inviteId },
      });
    });
  }

  /**
   * Stores the invite's key bundle, from `hostId`, a host of one of the workspace's sessions
   * (403 `host_required` otherwise). 410 for an invite that is expired, revoked, or accepted and
   * fetched; after acceptance a bundle waits 15 minutes, before it until the invite expires.
   */
  async putKeyBundle(inviteId: string, hostId: string, bundle: Buffer): Promise<void> {
    const now = this.#now();
    await this.#o.store.transaction(async (tx) => {
      const invite = await tx.lockById(inviteId);
      if (invite === null) throw unknownInvite();
      if (!(await tx.hostsSessionIn(invite.workspaceId, hostId))) {
        throw new AppError('host_required', { detail: INVITE_DETAILS.hostOnly });
      }
      const status = inviteStatus(invite, now);
      if (status === 'accepted') {
        if (invite.keyBundleFetchedAt !== null || invite.acceptedAt === null) {
          throw new AppError('gone', { detail: INVITE_DETAILS.used });
        }
        const until = new Date(invite.acceptedAt.getTime() + KEY_BUNDLE_AFTER_ACCEPT_MS);
        if (until.getTime() <= now.getTime()) {
          throw new AppError('gone', { detail: INVITE_DETAILS.used });
        }
        await tx.putKeyBundle(inviteId, bundle, until);
        return;
      }
      const refused = unusable(invite, now);
      if (refused !== null) throw refused;
      await tx.putKeyBundle(inviteId, bundle, invite.expiresAt);
    });
  }

  /**
   * The invite's key bundle, for `userId`, the user who accepted it (403 for anyone else, the
   * token alone is not enough); it is deleted as it is read, so the next fetch is a 410.
   */
  async takeKeyBundle(token: unknown, userId: string): Promise<Buffer> {
    if (!isInviteToken(token)) throw unknownInvite();
    const now = this.#now();
    const bundle = await this.#o.store.transaction(async (tx) => {
      const invite = await tx.lockByToken(hashInviteToken(token));
      if (invite === null) throw unknownInvite();
      if (invite.acceptedBy !== userId) throw forbidden(INVITE_DETAILS.notYours);
      return tx.takeKeyBundle(invite.id, now);
    });
    // After the commit: a bundle past its time is deleted even though the answer is a 410.
    if (bundle === null) throw new AppError('gone', { detail: INVITE_DETAILS.bundleGone });
    return bundle;
  }
}

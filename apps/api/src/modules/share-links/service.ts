/**
 * Share links (B068, CT-API-SESSIONS, CT-CRYPTO §4a, CT-RBAC "Share-link guests"): viewer-only
 * links the host creates and revokes, and the anonymous join that turns a link into a guest relay
 * ticket.
 *
 * - **create** (the host only):
 *   - `expires_in_s` is 60 to 86 400 (default 3 600) and `max_uses` 1 to 50 (default 10); out of
 *     range is 422. A link never outlives 24 h, whatever the client sends.
 *   - The token (`guest-ticket.ts`) is returned once, with its URL; only its SHA-256 is stored.
 *   - 20 per minute per user. If the counters fail, creating is let through (it needs a signed-in
 *     host).
 *   - Audited `invite.create` (`kind: share_link`, `role: viewer`).
 * - **revoke** (the host only):
 *   - The link is revoked and its guests deleted in one transaction, so the next join fails. The
 *     relay is told to close those guests (4403) in the same request. If it cannot be told, the
 *     revoke stands: the relay re-reads membership within 2 s and finds them gone.
 *   - Audited `invite.revoke`.
 * - **join** (public):
 *   - Rate limits first: 10 per minute per address and 30 per minute per token (keyed by the
 *     token's hash). If the counters fail, the join is refused 503 (fail closed).
 *   - The body needs a `display_name` (1-40 characters, no control characters). A `k` field (the
 *     E2E key belongs in the URL fragment) is refused 422. Anything else, a `role` included, is
 *     ignored: the role is always `viewer`.
 *   - These all get the same 404 problem body, after the same lookups, so they cannot be told
 *     apart:
 *     - an unknown, expired, revoked or used-up link;
 *     - a session that is over;
 *     - a workspace without `relay_access`.
 *   - A locked session is 403 `session_locked`. A full one is 403 `member_limit_reached`
 *     (`max_session_members`; guests count) or 403 `session_full` (B031's 50 slots).
 *   - One transaction spends a use, writes the guest (`mem_`, B031 slot) and signs the ticket.
 *     Concurrent joins never pass `max_uses`, and a signing failure (503) spends nothing.
 *   - The answer is B054's `JoinToken` with `role: viewer` and no caps. Audited `invite.accept`.
 * - **sweep(now)** deletes the guests of expired links and of sessions that are over, and tells
 *   the relay to close them.
 *
 * Owns: these rules. Must not: store or log a token or a ticket, issue any role but `viewer` to a
 * guest, or accept the E2E key.
 */
import { checkName, isId, newId, type Api } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  tooManyRequests,
  validationFailed,
  type AuditEmitter,
  type AuditEvent,
  type Logger,
  type Metrics,
  type RateLimitStore,
} from '@centcom/core';
import type { SessionSlotStore } from '@centcom/db';
import type { EntitlementEnforcer } from '../entitlements/enforcement.js';
import {
  GuestTicketError,
  hashShareToken,
  isShareTokenShape,
  issueGuestTicket,
  newShareToken,
  sameHash,
  SHARE_LINK_URL_BASE,
  GUEST_TICKET_TTL_S,
  type GuestTicketDeps,
} from './guest-ticket.js';
import type { ShareLinkRecord, ShareLinkStore } from './repository.js';

/** A link's default life (CT-CRYPTO §4a: 1 h), and its bounds (CT-DEEPLINK: at most 24 h). */
export const DEFAULT_EXPIRES_IN_S = 3_600;
export const MIN_EXPIRES_IN_S = 60;
export const MAX_EXPIRES_IN_S = 86_400;
/** Uses per link: default 10, at most 50. */
export const DEFAULT_MAX_USES = 10;
export const MAX_MAX_USES = 50;
/** Rate limits (per minute). */
export const CREATE_PER_USER = 20;
export const JOIN_PER_ADDRESS = 10;
export const JOIN_PER_TOKEN = 30;
/** B031's slots per session. */
export const MAX_SESSION_SLOTS = 50;
/** `retry_after_s` when a ticket or the counters are unavailable. */
const RETRY_AFTER_S = 5;

/** The details of the refusals (GUIDELINES §3.4). */
export const SHARE_LINK_DETAILS = Object.freeze({
  notFound: 'That link does not exist or can no longer be used.',
  sessionNotFound: 'That session does not exist.',
  hostOnly: 'Only the host can do that.',
  over: 'That session has ended.',
  locked: 'The host has locked this session.',
  memberLimit: 'This session already has as many members as its plan allows.',
  full: 'This session has no room for another member.',
  unavailable: 'Joining is unavailable right now. Try again shortly.',
  rateLimited: 'Too many attempts. Try again shortly.',
  relayUnknown: 'The session’s relay region is not available right now.',
} as const);

/** What the caller's standing in the session says (B054's `Standing`, the parts used here). */
export interface HostStanding {
  session: { id: string; workspaceId: string | null; state: string };
  /** The caller's live session role, capped by their workspace role; null when none. */
  role: 'host' | 'editor' | 'viewer' | null;
  /** The caller's live member id; null when none. */
  memberId: string | null;
  /** The caller may know the session exists (a live member, or in its workspace). */
  visible: boolean;
}

/** Tells the relay to close guests' connections (4403). */
export interface GuestNotifier {
  closeGuests(sessionId: string, memberIds: readonly string[]): Promise<void>;
}

/** What the service needs. */
export interface ShareLinkServiceDeps extends GuestTicketDeps {
  store: ShareLinkStore;
  /** The caller's standing in a session (from B054's route store); null for an unknown session. */
  standing(sessionId: string, userId: string): Promise<HostStanding | null>;
  /** B031. */
  slots: Pick<SessionSlotStore, 'assign'>;
  /** B080. */
  entitlements: Pick<EntitlementEnforcer, 'check'>;
  /** The relay's regions (B054's `relays`). */
  relays: { urls: Readonly<Record<string, string>> };
  notifier: GuestNotifier;
  /** B009's shared counters. */
  rateLimit: RateLimitStore;
  /** B036, for the anonymous join (the routes' own audit covers create and revoke). */
  audit?: Pick<AuditEmitter, 'emitDetached'>;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** A route's audit (`request.audit.detached`). */
export type RouteAudit = (
  input: Omit<AuditEvent, 'actor' | 'workspaceId' | 'outcome'> & {
    workspaceId: string | null;
    outcome?: AuditEvent['outcome'];
  },
) => void;

/** The body of a created link (CT-API-SESSIONS `ShareLink`, with `max_uses`). */
export interface ShareLinkBody {
  token: string;
  url: string;
  session: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  max_uses: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An integer field of `body` within `[min, max]`, or `fallback` when absent; 422 otherwise. */
function boundedInt(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw validationFailed([
      {
        pointer: `/${field}`,
        code: 'out_of_range',
        detail: `must be an integer from ${min} to ${max}`,
      },
    ]);
  }
  return value;
}

/** The share-link service. */
export class ShareLinkService {
  readonly #deps: ShareLinkServiceDeps;
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(deps: ShareLinkServiceDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** The caller's standing; 404 when they may not see the session, 403 when not its host. */
  async #host(sessionId: string, userId: string, audit: RouteAudit, attempted: string) {
    if (!isId('ses', sessionId)) {
      throw new AppError('session_not_found', { detail: SHARE_LINK_DETAILS.sessionNotFound });
    }
    const standing = await this.#deps.standing(sessionId, userId);
    if (standing === null || !standing.visible) {
      throw new AppError('session_not_found', { detail: SHARE_LINK_DETAILS.sessionNotFound });
    }
    if (standing.role !== 'host') {
      audit({
        action: 'permission.denied',
        workspaceId: standing.session.workspaceId,
        target: { type: 'session', id: sessionId },
        outcome: 'denied',
        meta: { attempted, reason: 'role', session_id: sessionId },
      });
      throw new AppError('host_required', { detail: SHARE_LINK_DETAILS.hostOnly });
    }
    return standing;
  }

  async create(
    sessionId: string,
    userId: string,
    body: unknown,
    audit: RouteAudit,
  ): Promise<ShareLinkBody> {
    const fields = body === undefined || body === null ? {} : body;
    if (!isRecord(fields)) {
      throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
    }
    const expiresIn = boundedInt(
      fields,
      'expires_in_s',
      MIN_EXPIRES_IN_S,
      MAX_EXPIRES_IN_S,
      DEFAULT_EXPIRES_IN_S,
    );
    const maxUses = boundedInt(fields, 'max_uses', 1, MAX_MAX_USES, DEFAULT_MAX_USES);
    const standing = await this.#host(sessionId, userId, audit, 'invite.create');
    if (standing.session.state === 'ended' || standing.session.state === 'expired') {
      throw new AppError('session_ended', { detail: SHARE_LINK_DETAILS.over });
    }
    await this.#limit(`share:create:${userId}`, CREATE_PER_USER, false);
    const now = this.#clock();
    const token = newShareToken();
    const link = await this.#deps.store.create({
      sessionId,
      tokenHash: hashShareToken(token),
      expiresAt: new Date(now + Math.min(expiresIn, MAX_EXPIRES_IN_S) * 1000),
      maxUses,
      createdByMember: standing.memberId ?? '',
      createdAt: new Date(now),
    });
    audit({
      action: 'invite.create',
      workspaceId: standing.session.workspaceId,
      target: { type: 'session', id: sessionId },
      meta: { role: 'viewer', kind: 'share_link' },
    });
    this.#metrics.counter('share_links_created_total').inc();
    this.#deps.logger?.info({ session: sessionId }, 'share_link.created');
    return {
      token,
      url: `${SHARE_LINK_URL_BASE}${token}`,
      session: sessionId,
      created_at: link.createdAt.toISOString(),
      expires_at: link.expiresAt.toISOString(),
      revoked_at: null,
      max_uses: link.maxUses,
    };
  }

  async revoke(sessionId: string, token: string, userId: string, audit: RouteAudit): Promise<void> {
    const standing = await this.#host(sessionId, userId, audit, 'invite.revoke');
    const notFound = () => new AppError('not_found', { detail: SHARE_LINK_DETAILS.notFound });
    if (!isShareTokenShape(token)) throw notFound();
    const revoked = await this.#deps.store.revoke(
      sessionId,
      hashShareToken(token),
      new Date(this.#clock()),
    );
    if (revoked === null) throw notFound();
    audit({
      action: 'invite.revoke',
      workspaceId: standing.session.workspaceId,
      target: { type: 'session', id: sessionId },
      meta: {},
    });
    await this.#close(sessionId, revoked.guests);
    this.#deps.logger?.info(
      { session: sessionId, count: revoked.guests.length },
      'share_link.revoked',
    );
  }

  /** Tells the relay to close `memberIds`; a failure is logged and counted (membership is gone). */
  async #close(sessionId: string, memberIds: readonly string[]): Promise<void> {
    if (memberIds.length === 0) return;
    try {
      await this.#deps.notifier.closeGuests(sessionId, memberIds);
    } catch (err) {
      this.#metrics.counter('share_link_close_failed_total').inc();
      this.#deps.logger?.warn(
        { session: sessionId, error: err instanceof Error ? err.name : typeof err },
        'share_link.close_failed',
      );
    }
  }

  /** Spends one call of a rate-limit bucket; 429 past it. `failClosed`: 503 when unreadable. */
  async #limit(key: string, limit: number, failClosed: boolean): Promise<void> {
    let result;
    try {
      result = await this.#deps.rateLimit.consume(key, limit, 60);
    } catch {
      if (!failClosed) return;
      throw new AppError('service_unavailable', {
        detail: SHARE_LINK_DETAILS.unavailable,
        retryAfterS: RETRY_AFTER_S,
      });
    }
    if (!result.allowed) throw tooManyRequests(result.resetS, SHARE_LINK_DETAILS.rateLimited);
  }

  #joined(result: string): void {
    this.#metrics.counter('share_link_joins_total', { result }).inc();
  }

  /** Exchanges a link's token for a guest's relay ticket. */
  async join(token: string, body: unknown, address: string): Promise<Api.JoinToken> {
    try {
      await this.#limit(`share:join:ip:${address}`, JOIN_PER_ADDRESS, true);
      const tokenKey = hashShareToken(typeof token === 'string' ? token : '').toString('hex');
      await this.#limit(`share:join:token:${tokenKey.slice(0, 32)}`, JOIN_PER_TOKEN, true);
    } catch (err) {
      this.#joined(
        err instanceof AppError && err.code === 'rate_limited' ? 'rate_limited' : 'unavailable',
      );
      throw err;
    }
    if (!isRecord(body)) {
      throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
    }
    if (Object.hasOwn(body, 'k')) {
      throw validationFailed([
        { pointer: '/k', code: 'not_allowed', detail: 'the key never goes to the server' },
      ]);
    }
    const name = checkName('displayName', body['display_name']);
    if (!name.ok) {
      throw validationFailed(
        name.errors.map((e) => ({ pointer: '/display_name', code: e.code, detail: e.detail })),
      );
    }

    const now = this.#clock();
    const notFound = (): AppError => {
      this.#joined('not_found');
      return new AppError('not_found', { detail: SHARE_LINK_DETAILS.notFound });
    };
    // The same two lookups whatever the link, so the refusals cannot be told apart by time.
    const hash = hashShareToken(isShareTokenShape(token) ? token : '');
    const found = isShareTokenShape(token) ? await this.#deps.store.findByHash(hash) : null;
    const link: ShareLinkRecord | null =
      found !== null && sameHash(found.tokenHash, hash) ? found : null;
    const session = await this.#deps.store.session(
      link?.sessionId ?? 'ses_00000000000000000000000000',
    );
    const usable =
      link !== null &&
      session !== null &&
      link.revokedAt === null &&
      link.expiresAt.getTime() > now &&
      link.uses < link.maxUses &&
      (session.state === 'live' || session.state === 'paused' || session.state === 'pending');
    if (!usable || link === null || session === null) throw notFound();

    const workspaceId = session.workspaceId;
    if (workspaceId === null) throw notFound();
    const check = async (key: 'relay_access' | 'max_session_members', current?: number) => {
      try {
        return await this.#deps.entitlements.check(workspaceId, key, current);
      } catch {
        this.#joined('unavailable');
        throw new AppError('service_unavailable', {
          detail: SHARE_LINK_DETAILS.unavailable,
          retryAfterS: RETRY_AFTER_S,
        });
      }
    };
    if (!(await check('relay_access')).allowed) throw notFound();
    if (session.locked) {
      this.#joined('locked');
      throw new AppError('session_locked', { detail: SHARE_LINK_DETAILS.locked });
    }
    const members = await this.#deps.store.countMembers(session.id);
    if (!(await check('max_session_members', members)).allowed) {
      this.#joined('member_limit');
      throw new AppError('member_limit_reached', { detail: SHARE_LINK_DETAILS.memberLimit });
    }
    const relayUrl = this.#deps.relays.urls[session.region];
    if (relayUrl === undefined) {
      throw new AppError('service_unavailable', {
        detail: SHARE_LINK_DETAILS.relayUnknown,
        retryAfterS: 30,
      });
    }
    const memberId = newId('mem');
    const slot = await this.#deps.slots.assign(session.id, memberId, MAX_SESSION_SLOTS);
    if (slot.kind === 'no_session') throw notFound();
    if (slot.kind === 'full') {
      this.#joined('full');
      throw new AppError('session_full', { detail: SHARE_LINK_DETAILS.full });
    }
    let consumed;
    try {
      consumed = await this.#deps.store.consume(
        link.id,
        new Date(now),
        { memberId, sessionId: session.id, name: name.value, slot: slot.slot },
        () => issueGuestTicket(this.#deps, session.id, memberId),
      );
    } catch (err) {
      await this.#release(session.id, memberId);
      if (err instanceof GuestTicketError) {
        this.#joined('unavailable');
        this.#metrics.counter('share_link_ticket_failures_total', { reason: err.reason }).inc();
        throw new AppError('service_unavailable', {
          detail: SHARE_LINK_DETAILS.unavailable,
          retryAfterS: RETRY_AFTER_S,
        });
      }
      throw err;
    }
    if (!consumed.ok) {
      await this.#release(session.id, memberId);
      throw notFound();
    }
    this.#joined('joined');
    this.#deps.audit?.emitDetached({
      workspaceId,
      actor: { type: 'system', id: 'api' },
      action: 'invite.accept',
      target: { type: 'session', id: session.id },
      outcome: 'success',
      meta: { role: 'viewer' },
    });
    this.#deps.logger?.info({ session: session.id, member: memberId }, 'share_link.joined');
    return {
      ticket: consumed.value,
      expires_in: GUEST_TICKET_TTL_S,
      relay_url: relayUrl,
      region: session.region,
      member: memberId as Api.JoinToken['member'],
      role: 'viewer',
      caps: [],
    };
  }

  async #release(sessionId: string, memberId: string): Promise<void> {
    try {
      await this.#deps.store.releaseSlot(sessionId, memberId);
    } catch (err) {
      this.#deps.logger?.warn(
        { session: sessionId, error: err instanceof Error ? err.name : typeof err },
        'share_link.slot_release_failed',
      );
    }
  }

  /** Deletes the guests of expired links and ended sessions, and closes them; how many. */
  async sweep(now: Date): Promise<number> {
    const gone = await this.#deps.store.sweep(now);
    let n = 0;
    for (const g of gone) {
      n += g.memberIds.length;
      await this.#close(g.sessionId, g.memberIds);
    }
    if (n > 0) this.#deps.logger?.info({ count: n }, 'share_link.guests_swept');
    return n;
  }
}

/**
 * The services of working together (B103): workspaces, members, invites, seats and share links,
 * built over the same connections as the rest of the context. Their routes are listed in
 * `modules.ts`.
 *
 * Owns: constructing these lanes' services. Must not: register routes, or read the environment.
 */
import {
  type AuditEmitter,
  type EmailQueue,
  type Logger,
  type Metrics,
  type RedisBackend,
  createEmailService,
  type EmailService,
} from '@centcom/core';
import {
  type CoreDatabase,
  type InviteDatabase,
  type SessionInviteDatabase,
  createSessionInviteStore,
  createInviteStore,
  createMemberStore,
  createWorkspaceStore,
} from '@centcom/db';
import type { Kysely } from 'kysely';
import type { ApiConfig } from './config.js';
import type { ApiDatabase } from './context.js';
import { createInviteUrlBuilder } from './modules/deeplinks/invite-urls.js';
import type { CachedEntitlements } from './modules/entitlements/enforcement.js';
import type { EntitlementService } from './modules/entitlements/service.js';
import { InviteService, SessionInviteService, type SeatGate } from './modules/invites/index.js';
import { MembershipService } from './modules/members/index.js';
import { SeatService, createSeatGate, seatLimitsFrom } from './modules/seats/index.js';
import { createPostgresShareLinkStore, ShareLinkService } from './modules/share-links/index.js';
import type { ShareLinkDb } from './modules/share-links/repository.js';
import { WorkspaceService } from './modules/workspaces/index.js';
import type { PurgeQueue } from './modules/workspaces/service.js';
import type { TokenService } from './modules/auth/tokens/index.js';
import { standingOf } from './routes/share-links/index.js';
import type { SessionRouteDeps } from './routes/sessions/index.js';

/** The services the collaboration routes draw on. */
export interface Collab {
  workspaceStore: ReturnType<typeof createWorkspaceStore>;
  workspaces: WorkspaceService;
  members: MembershipService;
  seatGate: SeatGate;
  /** Null when no mail transport is configured: invites cannot be sent. */
  invites: InviteService | null;
  inviteUrls: ReturnType<typeof createInviteUrlBuilder>;
  /** Null when the session routes are off (no relay address). */
  shareLinks: ShareLinkService | null;
  /** B105: null without a mail transport or without the session routes. */
  sessionInvites: SessionInviteService | null;
}

/** What the services are built from. */
export interface CollabDeps {
  config: ApiConfig;
  db: Kysely<ApiDatabase>;
  redis: RedisBackend;
  logger: Logger;
  metrics: Metrics;
  clock: () => number;
  audit: AuditEmitter;
  tokens: TokenService;
  entitlementService: EntitlementService;
  entitlements: CachedEntitlements;
  sessionRoutes: SessionRouteDeps | null;
  mailer: unknown;
  /** The worker's `workspace-purge` queue; without one a purge is only logged. */
  purgeQueue?: PurgeQueue;
}

/** Mails go to Mailpit until the worker's mail queue (B032) is on the list. */
function mailpitQueue(url: string, logger: Logger): EmailQueue {
  const endpoint = `${url.replace(/\/+$/, '')}/api/v1/send`;
  return {
    async add(name, data, opts) {
      const { email } = data;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          From: { Email: email.from.replace(/^.*<(.+)>$/, '$1') },
          To: [{ Email: email.to }],
          Subject: email.subject,
          Text: email.text,
          HTML: email.html,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        logger.warn({ template: name, status: response.status }, 'collab.mail_not_accepted');
        throw new Error('mail not accepted');
      }
      return { id: opts.jobId };
    },
  };
}

export function createCollab(deps: CollabDeps): Collab {
  const { config, db, redis, logger, metrics, clock } = deps;
  const view = <DB>(): Kysely<DB> => db as unknown as Kysely<DB>;

  const workspaceStore = createWorkspaceStore(view<CoreDatabase>());
  const workspaces = new WorkspaceService({
    store: workspaceStore,
    events: redis.pubsub,
    // A deleted workspace is purged by the worker (`pnpm dev:worker` locally).
    purgeQueue: deps.purgeQueue ?? {
      add: (name, data) => {
        logger.info({ job: name, workspace: data.workspaceId }, 'collab.purge_not_queued');
        return Promise.resolve();
      },
    },
    maxOwned: config.workspaces.maxOwned,
    clock,
    logger,
    metrics,
  });
  const members = new MembershipService({
    store: createMemberStore(view<CoreDatabase>()),
    events: redis.pubsub,
    clock,
    logger,
    metrics,
  });
  const seatGate = createSeatGate({
    seats: new SeatService({ db, now: clock }),
    limits: seatLimitsFrom(deps.entitlementService),
    metrics,
    logger,
  });
  const inviteUrls = createInviteUrlBuilder(config.deeplinks.webBase);

  let email: EmailService | null = null;
  if (config.mailpitUrl !== null) {
    email = createEmailService({
      queue: mailpitQueue(config.mailpitUrl, logger),
      rateLimit: redis.rateLimit,
      kv: redis.kv,
      from: 'Centcom <no-reply@centcom.test>',
      logger,
      metrics,
    });
  }
  const invites =
    email === null
      ? null
      : new InviteService({
          store: createInviteStore(view<InviteDatabase>()),
          members,
          urls: inviteUrls,
          email,
          clock,
          logger,
          metrics,
        });

  const routes = deps.sessionRoutes;
  const shareLinks =
    routes === null
      ? null
      : new ShareLinkService({
          store: createPostgresShareLinkStore(db as unknown as ShareLinkDb),
          standing: standingOf(routes.store),
          slots: routes.slots,
          entitlements: deps.entitlements,
          relays: routes.relays,
          // The relay re-reads membership every 2 s and drops guests whose link is gone.
          notifier: { closeGuests: () => Promise.resolve() },
          rateLimit: redis.rateLimit,
          audit: deps.audit,
          tickets: deps.tokens,
          issued: redis.kv,
          clock,
          logger,
          metrics,
        });

  const sessionInvites =
    email === null || routes === null
      ? null
      : new SessionInviteService({
          store: createSessionInviteStore(view<SessionInviteDatabase>()),
          urls: inviteUrls,
          email,
          entitlements: deps.entitlements,
          audit: deps.audit,
          clock,
          logger,
          metrics,
        });

  return {
    workspaceStore,
    workspaces,
    members,
    seatGate,
    invites,
    inviteUrls,
    shareLinks,
    sessionInvites,
  };
}

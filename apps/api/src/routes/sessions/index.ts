/**
 * Session REST routes (B054, CT-API-SESSIONS): list, create, get, patch, end, join-token,
 * claim-host and members, over B053's lifecycle service, B031's slots, B080's entitlements and
 * B017's relay tickets. `registerSessionRoutes(app, deps)` adds them.
 *
 * | Route                                  | Scope           | Who                             |
 * | -------------------------------------- | --------------- | ------------------------------- |
 * | `GET /v1/sessions`                     | `sessions:read` | member+ of `workspace`; or mine |
 * | `POST /v1/sessions`                    | `sessions:host` | member+ (Idempotency-Key)       |
 * | `GET /v1/sessions/{id}`                | `sessions:read` | who may see it (`access.ts`)    |
 * | `PATCH /v1/sessions/{id}`              | `sessions:host` | host (If-Match)                 |
 * | `POST /v1/sessions/{id}/end`           | `sessions:host` | host, workspace owner or admin  |
 * | `POST /v1/sessions/{id}/join-token`    | `sessions:write`| who may join                    |
 * | `POST /v1/sessions/{id}/claim-host`    | `sessions:host` | workspace owner or admin        |
 * | `GET /v1/sessions/{id}/members`        | `sessions:read` | live members                    |
 *
 * Users only (API keys 403). A session the caller may not see is 404 whatever they asked.
 * Register after the request-context, error-handler, auth, RBAC and audit plugins (and the
 * idempotency and rate-limit plugins, for replays and `RateLimit-*` headers).
 *
 * Owns: wiring the routes to their dependencies. Must not: hold state of its own.
 */
import type { KeyValue, Logger, Metrics, SigningKeys } from '@centcom/core';
import type { SessionSlotStore } from '@centcom/db';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { RelayTicketClaims } from '../../modules/auth/tokens/relay-ticket.js';
import type { EntitlementEnforcer } from '../../modules/entitlements/enforcement.js';
import type { SessionService } from '../../modules/sessions/index.js';
import { claimHostRoutes, deliverHostChanges } from './claim-host.js';
import { detailRoutes } from './detail.js';
import { joinTokenRoutes } from './join-token.js';
import { listCreateRoutes } from './list-create.js';
import { memberRoutes } from './members.js';
import type { SessionRouteStore } from './store.js';

export {
  createSessionRouteStore,
  HOST_OUTBOX_BASE_DELAY_MS,
  HOST_OUTBOX_MAX_DELAY_MS,
  type SessionRouteStore,
  type SessionRoutesDatabase,
  type SessionRoutesDb,
} from './store.js';
export { SESSION_ROUTE_DETAILS, sessionEtag } from './access.js';
export { deliverHostChanges };
export { JOIN_TICKET_RECORD_PREFIX, MAX_TICKET_CAPS } from './join-token.js';

/** Tells the relay the host changed (CT-WS-CONTROL `control.host_changed`). */
export interface HostChangeNotifier {
  hostChanged(sessionId: string, host: string, code: 'failover'): Promise<void>;
}

/** Relay regions and their URLs (CT-API-SESSIONS `region_hint`, `relay_url`). */
export interface RelayRegions {
  /** Where sessions go without a usable `region_preference`. */
  defaultRegion: string;
  /** `wss://` URL per region. */
  urls: Readonly<Record<string, string>>;
}

/** What the routes need. */
export interface SessionRouteDeps {
  /** B053. */
  service: Pick<SessionService, 'create' | 'get' | 'list' | 'rename' | 'setPolicyDefaults' | 'end'>;
  store: SessionRouteStore;
  /** B031: the member's slot. */
  slots: Pick<SessionSlotStore, 'assign'>;
  /** B080: `relay_access` and `max_session_members` for new members. */
  entitlements: Pick<EntitlementEnforcer, 'check'>;
  /** B017. */
  tickets: { mintRelayTicket(claims: RelayTicketClaims): Promise<string> };
  /** Where issued tickets' `jti`s are recorded for 60 s. */
  issued: Pick<KeyValue, 'set'>;
  hostNotifier: HostChangeNotifier;
  relays: RelayRegions;
  /** CURSOR_SIGNING_KEYS (B025), for the members list. */
  cursorKeys: SigningKeys;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const plugin: FastifyPluginAsync<SessionRouteDeps> = async (app, deps) => {
  await app.register(listCreateRoutes, deps);
  await app.register(detailRoutes, deps);
  await app.register(joinTokenRoutes, deps);
  await app.register(claimHostRoutes, deps);
  await app.register(memberRoutes, deps);
};

/** Adds the session routes to `app`. */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  void app.register(plugin, deps);
}

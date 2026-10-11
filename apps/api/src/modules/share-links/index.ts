/**
 * Share links (B068, CT-API-SESSIONS, CT-CRYPTO §4a): viewer-only links and the guests who join
 * through them. The routes are `routes/share-links/`.
 */
export {
  GUEST_TICKET_RECORD_PREFIX,
  GUEST_TICKET_TTL_S,
  GuestTicketError,
  hashShareToken,
  isShareTokenShape,
  issueGuestTicket,
  newShareToken,
  sameHash,
  SHARE_LINK_URL_BASE,
  SHARE_TOKEN_BYTES,
  type GuestTicketDeps,
} from './guest-ticket.js';
export {
  createPostgresShareLinkStore,
  type JoinSession,
  type NewGuest,
  type ShareLinkDb,
  type ShareLinkRecord,
  type ShareLinkStore,
} from './repository.js';
export {
  CREATE_PER_USER,
  DEFAULT_EXPIRES_IN_S,
  DEFAULT_MAX_USES,
  JOIN_PER_ADDRESS,
  JOIN_PER_TOKEN,
  MAX_EXPIRES_IN_S,
  MAX_MAX_USES,
  MIN_EXPIRES_IN_S,
  SHARE_LINK_DETAILS,
  ShareLinkService,
  type GuestNotifier,
  type HostStanding,
  type RouteAudit,
  type ShareLinkBody,
  type ShareLinkServiceDeps,
} from './service.js';

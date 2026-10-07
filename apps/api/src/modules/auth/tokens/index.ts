/**
 * Token module (B017): the token service and its parts. Grant lanes (B016, B018) call
 * `issueTokens` and `registerGrantHandler`; API keys (B019) `registerPrincipalResolver`; devices
 * (B020) `revokeDevice`; the sessions lane `mintRelayTicket`. HTTP: `routes/auth/token.ts`,
 * `routes/auth/revoke.ts`, `routes/well-known.ts`, and `plugins/auth.ts` for every other route.
 */
export {
  loadTokenKeys,
  MAX_SIGNING_KEYS,
  parseSigningKeys,
  tokenEnvSchema,
  type SigningKey,
  type TokenKeys,
} from './config.js';
export {
  ACCESS_TOKEN_TTL_S,
  ACCESS_TOKEN_TYPE,
  ALGORITHM,
  API_AUDIENCE,
  CLOCK_SKEW_S,
  signAccessToken,
  signJwt,
  TOKEN_ISSUER,
  verifyAccessJwt,
  verifyJwt,
  type AccessClaims,
  type AccessTokenInput,
  type Plan,
} from './jwt.js';
export { generateSigningJwk, publicJwks, type PublicJwk } from './keys.js';
export {
  decideRotation,
  hashRefreshToken,
  REFRESH_ABSOLUTE_MS,
  REFRESH_SLIDING_MS,
  REFRESH_TOKEN_SHAPE,
  RefreshTokenStore,
  invalidRefreshToken,
  newRefreshToken,
  refreshReuseDetected,
  type RefreshGrant,
  type RefreshStore,
  type RotationDecision,
} from './refresh.js';
export {
  mintRelayTicket,
  RELAY_AUDIENCE,
  RELAY_TICKET_TTL_S,
  RELAY_TICKET_TYPE,
  type RelayTicketClaims,
  type SessionRole,
} from './relay-ticket.js';
export {
  ADMIN_SCOPE,
  REVOCATION_TTL_MS,
  RevocationList,
  type RevocationState,
} from './revocation.js';
export {
  CLIENT_IDS,
  FREE_ENTITLEMENTS,
  SCOPES,
  TokenService,
  type EntitlementsLookup,
  type GrantHandler,
  type IssueInput,
  type Principal,
  type PrincipalResolver,
  type TokenRequest,
  type TokenResponse,
  type TokenServiceDeps,
} from './service.js';

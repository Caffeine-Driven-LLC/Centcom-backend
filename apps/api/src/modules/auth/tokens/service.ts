/**
 * Token service (B017): one place that issues access and refresh tokens, rotates refresh tokens,
 * verifies access tokens (signature, claims, revocation), revokes tokens and devices, mints relay
 * tickets and publishes the JWKS. Grant types plug in through `registerGrantHandler` (B016 device
 * code, B018 authorization code; `refresh_token` is built in) and other bearer credentials through
 * `registerPrincipalResolver` (B019 API keys, `cen_`).
 *
 * Owns: token issue and verification. Must not: log or return a token anywhere but the token
 * endpoint's response, issue tokens for a revoked device, or accept a scope the grant did not hold.
 */
import { isId, type Api } from '@centcom/contracts';
import { AppError, unavailable, type KeyValue, type Logger, type Metrics } from '@centcom/core';
import { isConnectionError, type ClientId, type TokenDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import type { TokenKeys } from './config.js';
import { publicJwks } from './keys.js';
import {
  ACCESS_TOKEN_TTL_S,
  signAccessToken,
  verifyAccessJwt,
  type AccessClaims,
  type Plan,
} from './jwt.js';
import { RefreshTokenStore, type RefreshGrant, type RefreshStore } from './refresh.js';
import { mintRelayTicket, type RelayTicketClaims } from './relay-ticket.js';
import { RevocationList } from './revocation.js';

/** CT-AUTH scopes. */
export const SCOPES = [
  'profile',
  'workspaces:read',
  'workspaces:write',
  'sessions:read',
  'sessions:write',
  'sessions:host',
  'billing:read',
  'billing:write',
  'usage:write',
  'webhooks:write',
  'audit:read',
  'admin',
] as const;
const KNOWN_SCOPES: ReadonlySet<string> = new Set(SCOPES);

/** CT-AUTH public clients. */
export const CLIENT_IDS: readonly ClientId[] = ['centcom-cli', 'centcom-web', 'centcom-tui'];

/** Plan and entitlement revision for the `plan` and `ent` claims (the billing lanes provide the real one). */
export interface EntitlementsLookup {
  lookup(userId: string, workspaceId: string | null): Promise<{ plan: Plan; ent: number }>;
}

/** Until billing exists: everyone is on `free`, revision 0. */
export const FREE_ENTITLEMENTS: EntitlementsLookup = {
  lookup: () => Promise.resolve({ plan: 'free', ent: 0 }),
};

/** The token endpoint's response (CT-AUTH `TokenResponse`). */
export type TokenResponse = Api.TokenResponse;

/** A token request as the endpoint parsed it: `grant_type`, a known `client_id`, the grant's own fields. */
export type TokenRequest = {
  readonly grant_type: string;
  readonly client_id: ClientId;
  readonly [field: string]: unknown;
};

/** Answers one grant type. */
export type GrantHandler = (request: TokenRequest) => Promise<TokenResponse>;

/** Who is calling. */
export interface Principal {
  /** `user` for access tokens; a resolver names its own (B019: `api_key`). */
  kind: string;
  userId: string | null;
  deviceId: string | null;
  workspaceId: string | null;
  scopes: readonly string[];
  /** The access token's claims, for `user` principals. */
  claims?: AccessClaims;
  /** The `key_` id, for `api_key` principals (B019). */
  keyId?: string;
}

/** Turns a bearer credential with a registered prefix into a principal, or throws a 401 AppError. */
export type PrincipalResolver = (credential: string) => Promise<Principal>;

/** What `issueTokens` needs. */
export interface IssueInput {
  userId: string;
  /** The device the tokens are bound to; null for a client without one. */
  deviceId: string | null;
  scopes: readonly string[];
  workspaceId?: string;
  /** Default `centcom-cli`. */
  clientId?: ClientId;
}

/** Dependencies of the token service. */
export interface TokenServiceDeps {
  db: Kysely<TokenDatabase>;
  keys: TokenKeys;
  /** Revocation flags (B009). */
  kv: KeyValue;
  /** Default: `RefreshTokenStore` over `db`. */
  store?: RefreshStore;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  entitlements?: EntitlementsLookup;
  logger?: Logger;
  metrics?: Metrics;
}

/** 400 `invalid_scope`. */
const invalidScope = (): AppError =>
  new AppError('invalid_scope', { detail: 'The scope is not valid for this grant.' });

/** Scopes from a space-separated string or a list: known, at least one, no repeats (sorted for stable output). */
function checkScopes(scopes: readonly string[]): string[] {
  const unique = [...new Set(scopes)];
  if (
    unique.length === 0 ||
    unique.length !== scopes.length ||
    !unique.every((scope) => KNOWN_SCOPES.has(scope))
  ) {
    throw invalidScope();
  }
  return unique;
}

const splitScope = (scope: string): string[] => scope.split(' ').filter((part) => part !== '');

/** Runs a database step; a lost connection becomes a 503 whose cause holds no connection details. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    throw unavailable(undefined, undefined, { cause: new Error('database unavailable') });
  }
}

/** Issues, refreshes, verifies and revokes tokens. */
export class TokenService {
  private readonly keys: TokenKeys;
  private readonly now: () => number;
  private readonly entitlements: EntitlementsLookup;
  private readonly logger: Logger | undefined;
  private readonly store: RefreshStore;
  private readonly revocations: RevocationList;
  private readonly grants = new Map<string, GrantHandler>();
  private readonly resolvers = new Map<string, PrincipalResolver>();

  constructor(deps: TokenServiceDeps) {
    this.keys = deps.keys;
    this.now = deps.now ?? Date.now;
    this.entitlements = deps.entitlements ?? FREE_ENTITLEMENTS;
    this.logger = deps.logger;
    this.store = deps.store ?? new RefreshTokenStore({ db: deps.db, now: this.now });
    this.revocations = new RevocationList({
      kv: deps.kv,
      now: this.now,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
    });
    this.registerGrantHandler('refresh_token', (request) => this.refreshGrant(request));
  }

  /**
   * An access token and the first refresh token of a new family for a signed-in user: what grant
   * handlers return once they have authenticated someone. The device must be the user's and live.
   */
  async issueTokens(input: IssueInput): Promise<TokenResponse> {
    const scopes = checkScopes(input.scopes);
    if (
      !isId('usr', input.userId) ||
      (input.workspaceId !== undefined && !isId('wsp', input.workspaceId))
    ) {
      throw new AppError('invalid_request', { detail: 'The user or workspace id is not valid.' });
    }
    const clientId = input.clientId ?? 'centcom-cli';
    if (input.deviceId !== null) await this.checkDevice(input.deviceId, input.userId);
    const grant: RefreshGrant = {
      userId: input.userId,
      deviceId: input.deviceId,
      clientId,
      scope: scopes.join(' '),
      workspaceId: input.workspaceId ?? null,
    };
    const refreshToken = await guarded(() => this.store.issue(grant));
    return this.respond(grant, scopes, refreshToken);
  }

  /**
   * The `refresh_token` grant: spends `refreshToken` and returns new tokens. `scope` may narrow
   * the access token to a subset of the grant (the refresh token keeps the whole grant).
   */
  async refresh(input: {
    refreshToken: string;
    clientId: ClientId;
    scope?: string;
  }): Promise<TokenResponse> {
    const { token, grant } = await guarded(() =>
      this.store.rotate(input.refreshToken, input.clientId, (familyId) =>
        this.logger?.warn({ family_id: familyId }, 'auth.refresh_reuse_detected: family revoked'),
      ),
    );
    const granted = splitScope(grant.scope);
    let scopes = granted;
    if (input.scope !== undefined) {
      scopes = checkScopes(splitScope(input.scope));
      if (!scopes.every((scope) => granted.includes(scope))) throw invalidScope();
    }
    return this.respond(grant, scopes, token);
  }

  /** The claims of a valid, unrevoked access token; 401 `token_expired|token_invalid|token_revoked|device_revoked`. */
  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const claims = await verifyAccessJwt(this.keys, token, this.now());
    const state = await this.revocations.check(claims);
    if (state === 'device_revoked')
      throw new AppError('device_revoked', { detail: 'The device was revoked.' });
    if (state === 'token_revoked')
      throw new AppError('token_revoked', { detail: 'The access token was revoked.' });
    return claims;
  }

  /** The principal behind a bearer credential: a registered resolver by prefix, else an access token. */
  async authenticate(credential: string): Promise<Principal> {
    for (const [prefix, resolve] of this.resolvers) {
      if (credential.startsWith(prefix)) return resolve(credential);
    }
    const claims = await this.verifyAccessToken(credential);
    return {
      kind: 'user',
      userId: claims.sub,
      deviceId: claims.dev ?? null,
      workspaceId: claims.wsp ?? null,
      scopes: splitScope(claims.scp),
      claims,
    };
  }

  /** Adds (or replaces) the handler of a grant type for `POST /v1/auth/token`. */
  registerGrantHandler(grantType: string, handler: GrantHandler): void {
    this.grants.set(grantType, handler);
  }

  /** The handler of a grant type, if any. */
  grantHandler(grantType: string): GrantHandler | undefined {
    return this.grants.get(grantType);
  }

  /** Bearer credentials starting with `prefix` (such as `cen_`) are resolved by `resolver`. */
  registerPrincipalResolver(prefix: string, resolver: PrincipalResolver): void {
    if (prefix === '')
      throw new TypeError('registerPrincipalResolver: the prefix must not be empty');
    this.resolvers.set(prefix, resolver);
  }

  /** Revokes a device: its record, every refresh token bound to it, and (within 1 s) its access tokens. */
  async revokeDevice(deviceId: string): Promise<void> {
    await guarded(() => this.store.revokeDevice(deviceId));
    await this.revocations.revokeDevice(deviceId);
  }

  /** Revokes every refresh token of a family. */
  async revokeFamily(familyId: string): Promise<void> {
    await guarded(() => this.store.revokeFamily(familyId));
  }

  /** Revokes one access token until it would have expired (`expUnix`, seconds). */
  async revokeAccessJti(jti: string, expUnix: number): Promise<void> {
    await this.revocations.revokeJti(jti, expUnix);
  }

  /** `POST /v1/auth/revoke` with a token: revokes its family when it is the caller's; nothing otherwise. */
  async revokeRefreshToken(token: string, userId: string): Promise<void> {
    await guarded(() => this.store.revokeByToken(token, userId));
  }

  /** `POST /v1/auth/revoke` with a device: revokes it when it is the caller's; nothing otherwise. */
  async revokeOwnDevice(deviceId: string, userId: string): Promise<void> {
    const device = await guarded(() => this.store.device(deviceId));
    if (device?.userId === userId) await this.revokeDevice(deviceId);
  }

  /** A relay ticket (60 s, single use at the relay). */
  async mintRelayTicket(claims: RelayTicketClaims): Promise<string> {
    return mintRelayTicket(this.keys, claims, this.now());
  }

  /** The public JWKS. */
  jwks(): Api.Jwks {
    return publicJwks(this.keys);
  }

  private async refreshGrant(request: TokenRequest): Promise<TokenResponse> {
    const { refresh_token: refreshToken, scope } = request;
    if (
      typeof refreshToken !== 'string' ||
      refreshToken === '' ||
      (scope !== undefined && typeof scope !== 'string')
    ) {
      throw new AppError('invalid_request', {
        detail: 'refresh_token is required; scope, when given, is a string.',
      });
    }
    return this.refresh({
      refreshToken,
      clientId: request.client_id,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  /** 401 `device_revoked` for a revoked device, 400 `invalid_grant` for one that is unknown or another user's. */
  private async checkDevice(deviceId: string, userId: string): Promise<void> {
    const device = isId('dev', deviceId)
      ? await guarded(() => this.store.device(deviceId))
      : undefined;
    if (device?.userId !== userId)
      throw new AppError('invalid_grant', { detail: 'The device is not valid for this user.' });
    if (device.revoked) throw new AppError('device_revoked', { detail: 'The device was revoked.' });
  }

  private async respond(
    grant: RefreshGrant,
    scopes: readonly string[],
    refreshToken: string,
  ): Promise<TokenResponse> {
    const { plan, ent } = await this.entitlements.lookup(grant.userId, grant.workspaceId);
    const { token } = await signAccessToken(
      this.keys,
      {
        sub: grant.userId,
        scp: scopes.join(' '),
        plan,
        ent,
        ...(grant.deviceId === null ? {} : { dev: grant.deviceId }),
        ...(grant.workspaceId === null ? {} : { wsp: grant.workspaceId }),
      },
      this.now(),
    );
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
      user: grant.userId,
      ...(grant.deviceId === null ? {} : { device: grant.deviceId }),
    };
  }
}

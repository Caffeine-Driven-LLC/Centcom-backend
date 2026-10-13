/**
 * The route modules the API serves (B102). One explicit list: a lane that adds routes adds an
 * entry here, with the services it needs on `AppContext`. A module whose dependencies are not
 * configured says why in `skip` and is left out with one log line; the rest of the app still boots.
 *
 * Owns: which routes exist and in what order they register. Must not: build services (that is
 * `context.ts`) or read the environment.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { deviceRoutes as deviceGrantRoutes } from './modules/auth/device/routes.js';
import { webLoginCompleter } from './modules/auth/web-session/store.js';
import { devicePages } from './pages/device.js';
import { authDeviceRoutes } from './routes/auth-devices.js';
import { authorizeRoutes } from './routes/auth/authorize.js';
import { revokeRoutes } from './routes/auth/revoke.js';
import { tokenRoutes } from './routes/auth/token.js';
import { deviceRoutes } from './routes/devices.js';
import { emailLoginRoutes } from './routes/login-email.js';
import { meRoutes } from './routes/me.js';
import { inviteRoutes } from './modules/invites/index.js';
import { memberRoutes } from './modules/members/index.js';
import { seatGatePlugin } from './modules/seats/index.js';
import { workspaceRoutes } from './modules/workspaces/index.js';
import { entitlementRoutes } from './routes/entitlements/index.js';
import { registerShareLinkRoutes } from './routes/share-links/index.js';
import { registerSessionRoutes } from './routes/sessions/index.js';
import { statusRoutes } from './routes/status.js';
import { wellKnownRoutes } from './routes/well-known.js';

/** One entry of the list. */
export interface ApiModule {
  name: string;
  /** Why the module cannot run with this configuration, or null when it can. */
  skip?(ctx: AppContext): string | null;
  register(app: FastifyInstance, ctx: AppContext): Promise<void>;
}

export const API_MODULES: readonly ApiModule[] = [
  {
    name: 'status',
    register: async (app, ctx) => {
      await app.register(statusRoutes, { feed: ctx.statusFeed, readiness: ctx.readiness });
    },
  },
  {
    name: 'jwks',
    register: async (app, ctx) => {
      await app.register(wellKnownRoutes, { tokens: ctx.tokens });
    },
  },
  {
    name: 'token',
    register: async (app, ctx) => {
      await app.register(tokenRoutes, { tokens: ctx.tokens });
      await app.register(revokeRoutes, { tokens: ctx.tokens });
    },
  },
  {
    name: 'device-grant',
    register: async (app, ctx) => {
      await app.register(deviceGrantRoutes, { devices: ctx.deviceGrants });
    },
  },
  {
    name: 'device-pages',
    register: async (app, ctx) => {
      await app.register(devicePages, {
        devices: ctx.deviceGrants,
        sessions: ctx.sessions,
        returnTo: ctx.deviceReturnTo,
        trustedHops: ctx.config.base.trustedProxyHops,
        secureCookies: ctx.config.secureCookies,
        logger: ctx.logger,
      });
    },
  },
  {
    name: 'authorize',
    register: async (app, ctx) => {
      await app.register(authorizeRoutes, { authorizer: ctx.authorizer, sessions: ctx.sessions });
    },
  },
  {
    name: 'email-login',
    skip: (ctx) =>
      ctx.magicLink === null ? 'no mail transport is configured (DEV_MAILPIT_URL)' : null,
    register: async (app, ctx) => {
      const { magicLink, config } = ctx;
      if (magicLink === null || config.magicLink === null) return;
      await app.register(emailLoginRoutes, {
        magicLink,
        completer: webLoginCompleter(ctx.sessions),
        ttlS: config.magicLink.ttlS,
        secureCookies: config.secureCookies,
        logger: ctx.logger,
      });
    },
  },
  {
    name: 'me',
    register: async (app, ctx) => {
      await app.register(meRoutes, {
        me: ctx.me,
        caller: (request) => {
          const p = request.principal;
          if (p === null || p.userId === null) return null;
          return {
            kind: 'user',
            userId: p.userId,
            scopes: p.scopes,
            ...(p.workspaceId === null ? {} : { workspaceId: p.workspaceId }),
          };
        },
      });
    },
  },
  {
    name: 'devices',
    register: async (app, ctx) => {
      const options = {
        devices: ctx.devices,
        cursorKeys: ctx.config.pagination.signingKeys,
        clock: ctx.clock ?? Date.now,
      };
      await app.register(deviceRoutes, options);
      await app.register(authDeviceRoutes, options);
    },
  },
  {
    name: 'sessions',
    skip: (ctx) =>
      ctx.sessionRoutes === null ? 'no relay address is configured (RELAY_PUBLIC_URL)' : null,
    register: async (app, ctx) => {
      if (ctx.sessionRoutes !== null) registerSessionRoutes(app, ctx.sessionRoutes);
    },
  },
  {
    name: 'workspaces',
    register: async (app, ctx) => {
      await app.register(workspaceRoutes, {
        service: ctx.collab.workspaces,
        cursorKeys: ctx.config.pagination.signingKeys,
        clock: ctx.clock ?? Date.now,
      });
      await app.register(memberRoutes, {
        members: ctx.collab.members,
        workspaces: ctx.collab.workspaceStore,
        cursorKeys: ctx.config.pagination.signingKeys,
        clock: ctx.clock ?? Date.now,
      });
      await app.register(entitlementRoutes, { service: ctx.entitlements });
    },
  },
  {
    name: 'invites',
    skip: (ctx) =>
      ctx.collab.invites === null
        ? 'no mail transport is configured (DEV_MAILPIT_URL)'
        : ctx.config.idempotency.encryptionKey === undefined
          ? 'IDEMPOTENCY_ENCRYPTION_KEY is not set'
          : null,
    register: async (app, ctx) => {
      if (ctx.collab.invites === null) return;
      await app.register(seatGatePlugin, { gate: ctx.collab.seatGate });
      await app.register(inviteRoutes, {
        service: ctx.collab.invites,
        workspaces: ctx.collab.workspaceStore,
        cursorKeys: ctx.config.pagination.signingKeys,
        clock: ctx.clock ?? Date.now,
      });
    },
  },
  {
    name: 'share-links',
    skip: (ctx) =>
      ctx.collab.shareLinks === null ? 'the session routes are off (RELAY_PUBLIC_URL)' : null,
    register: async (app, ctx) => {
      if (ctx.collab.shareLinks !== null && ctx.sessionRoutes !== null) {
        registerShareLinkRoutes(app, {
          service: ctx.collab.shareLinks,
          members: ctx.sessionRoutes.store,
          cursorKeys: ctx.config.pagination.signingKeys,
          clock: ctx.clock ?? Date.now,
        });
      }
    },
  },
];

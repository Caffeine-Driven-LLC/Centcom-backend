/**
 * The internal admin API (B087): `/internal/admin/v1` for Centcom staff, on its own listener.
 *
 * - **Listener:** `createAdminServer` builds a Fastify instance of its own (never the public one:
 *   the plugin refuses any other instance, and any route outside `/internal/admin/v1`), whose
 *   socket drops every connection from outside ADMIN_ALLOWED_CIDRS before reading a byte.
 *   `startAdminServer` starts it only when ADMIN_API_ENABLED is true.
 * - **Access:** every route's preHandler is `requireStaff(minRole)` (modules/admin/staff.ts).
 * - **Audit, every call:** exactly one `staff.access` event (with its reason and ticket) per
 *   request, allowed, refused or failed, reads as well as writes, written before the response
 *   leaves:
 *   - a read is answered, then its event is written in `onSend`; if that fails, the body is
 *     replaced by a 503 and no data leaves;
 *   - a write writes its event first, in a transaction that commits only if the action succeeds
 *     (`POST /incidents` writes it right after the action, in that same transaction, so it can
 *     name the new incident). If the event cannot be written, nothing is done: 503;
 *   - a refusal or failure (any problem, Fastify's own included) is written in `onSend`; if that
 *     fails, the answer becomes a 503.
 * - **Failures:** a 4xx problem from the work behind a route is passed on; anything else a
 *   dependency throws is a 502 `bad_gateway`; an action not wired yet is a 503.
 *
 * Owns: the routes, the listener and the audit hooks. Must not: register on the public listener,
 * answer before the call is recorded, or put a URL, header value or body in an event or a log.
 */
import type { Socket } from 'node:net';
import { isId } from '@centcom/contracts';
import {
  AppError,
  isAppError,
  noopMetrics,
  PROBLEM_CONTENT_TYPE,
  toProblem,
  unavailable,
  type AuditTarget,
  type Logger,
  type Metrics,
} from '@centcom/core';
import type { IdPrefix } from '@centcom/contracts';
import type { StaffRole } from '@centcom/db';
import {
  fastify,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from 'fastify';
import {
  callDetails,
  callEvent,
  newCall,
  outcomeOf,
  type AdminCall,
  type StaffMember,
} from '../modules/admin/call.js';
import { cidrMatcher, type Cidr } from '../modules/admin/cidr.js';
import { ADMIN_BASE, type AdminConfig } from '../modules/admin/config.js';
import type { AdminStore, AdminWriter } from '../modules/admin/repository.js';
import { NotWiredError, type AdminService, type AfterCommit } from '../modules/admin/service.js';
import { requireStaff, type AdminAccess } from '../modules/admin/staff.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../plugins/error-handler.js';
import { requestContextPlugin, UNMATCHED_ROUTE } from '../plugins/request-context.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route of the admin listener, as registered (the audit completeness test walks them). */
    adminRoutes: readonly { method: string; url: string }[];
  }
}

/** What the admin plugin needs. */
export interface InternalAdminOptions {
  service: AdminService;
  store: AdminStore;
  access: AdminAccess;
  logger?: Logger;
  metrics?: Metrics;
}

/** The decorator `createAdminServer` sets; the plugin refuses an instance without it. */
const LISTENER_MARK = 'centcomAdminListener';

/** The user-facing details of the plugin's problems. */
export const INTERNAL_ADMIN_DETAILS = Object.freeze({
  auditUnavailable: 'The admin API cannot record this call right now; nothing was done.',
  dependency: 'A service behind the admin API failed.',
} as const);

/** The call's event could not be written (or its transaction not committed). */
class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super('admin audit write failed', { cause });
    this.name = 'AuditWriteError';
  }
}

const auditUnavailable = (): AppError =>
  unavailable(undefined, INTERNAL_ADMIN_DETAILS.auditUnavailable);

/** How a write records its call: before the action, or right after it in the same transaction. */
type RecordMode = 'before' | 'after';

/** The handler's view of a call. */
interface RouteContext {
  request: FastifyRequest;
  call: AdminCall;
  staff: StaffMember;
}

/** An admin route. */
interface RouteSpec {
  method: HTTPMethods;
  /** Under ADMIN_BASE. */
  path: string;
  minRole: StaffRole;
  /** Query parameters taken; any other is refused. */
  query?: readonly string[];
  /** 200 unless set. */
  status?: number;
  /** The target named by the path, set before any work. */
  target?: (params: Record<string, string>) => AuditTarget | null;
  /** The flag key named by the path. */
  flag?: (params: Record<string, string>) => string;
  read?: (ctx: RouteContext) => Promise<unknown>;
  write?: {
    record: RecordMode;
    run: (ctx: RouteContext, tx: AdminWriter, after: AfterCommit) => Promise<unknown>;
  };
}

/** `{type, id}` when `id` is a `prefix` id, else null (the route answers 404 for it). */
const targetOf =
  (type: string, prefix: IdPrefix, param: string) =>
  (params: Record<string, string>): AuditTarget | null => {
    const id = params[param];
    return isId(prefix, id) ? { type, id } : null;
  };

/** The `code` of a problem body, if `payload` is one. */
function problemCode(payload: unknown): string | null {
  const text = Buffer.isBuffer(payload)
    ? payload.toString('utf8')
    : typeof payload === 'string'
      ? payload
      : null;
  if (text === null) return null;
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;

/** An error's name, the only part of it logged (messages can hold hosts and addresses). */
const errorName = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err === 'object' && err !== null ? 'Object' : typeof err;

/**
 * For a call refused before the access checks ran (a 404, a body Fastify could not parse): who
 * made it, as far as their credential says. Never throws.
 */
async function attribute(request: FastifyRequest, call: AdminCall, access: AdminAccess) {
  const header = request.headers.authorization;
  const credential = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
  if (credential === undefined) return;
  try {
    const principal = await access.tokens.authenticate(credential);
    if (principal.kind !== 'user' || principal.userId === null) return;
    call.actor = { type: 'user', id: principal.userId };
    if (!principal.scopes.includes('admin')) return;
    const role = await access.directory.role(principal.userId);
    if (role !== null) {
      call.actor = { type: 'staff', id: principal.userId };
      call.staff = { userId: principal.userId, role };
    }
  } catch {
    // Anonymous, then.
  }
}

const plugin: FastifyPluginAsync<InternalAdminOptions> = async (app, opts) => {
  if (!app.hasDecorator(LISTENER_MARK)) {
    throw new Error('internalAdminPlugin: register it through createAdminServer only');
  }
  const metrics = opts.metrics ?? noopMetrics;
  const { store, access, service, logger } = opts;

  const registered: { method: string; url: string }[] = [];
  app.decorate('adminAccess', access);
  app.decorate('adminRoutes', registered);
  app.decorateRequest('adminCall', null);

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${ADMIN_BASE}/`)) {
      throw new Error(`the admin listener serves ${ADMIN_BASE} only, not ${route.url}`);
    }
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      registered.push({ method, url: route.url });
    }
  });

  app.addHook('onRequest', async (request) => {
    request.adminCall = newCall(
      request.id,
      request.method,
      request.routeOptions.url ?? UNMATCHED_ROUTE,
    );
  });

  // Every response not yet recorded (reads, refusals, failures) is recorded before it leaves.
  app.addHook('onSend', async (request, reply, payload) => {
    const call = request.adminCall;
    if (call === null || call.recorded) return payload;
    call.recorded = true;
    const status = reply.statusCode;
    if (!call.checked) await attribute(request, call, access);
    const outcome = outcomeOf(call, status);
    try {
      await store.transaction((tx) =>
        tx.record(
          callEvent(call, outcome, status, status >= 400 ? problemCode(payload) : null),
          callDetails(call),
        ),
      );
      metrics.counter('admin_calls_total', { outcome }).inc();
      return payload;
    } catch (err) {
      metrics.counter('admin_audit_failures_total').inc();
      logger?.error(
        { route: call.route, status, err: { name: errorName(err) } },
        'admin.audit_failed: response withheld',
      );
      const problem = toProblem(auditUnavailable(), { requestId: request.id });
      void reply.code(503);
      reply.removeHeader('content-length');
      reply.removeHeader('etag');
      reply.removeHeader('location');
      void reply.header('content-type', PROBLEM_CONTENT_TYPE);
      void reply.header('retry-after', String(problem.retry_after_s ?? 1));
      return Buffer.from(JSON.stringify(problem));
    }
  });

  /** A failure of the work behind a route, as the caller sees it (see the file comment). */
  const failure = (err: unknown, call: AdminCall): unknown => {
    if (err instanceof AuditWriteError) {
      metrics.counter('admin_audit_failures_total').inc();
      logger?.error(
        { route: call.route, err: { name: errorName(err.cause) } },
        'admin.audit_failed: action not done',
      );
      return auditUnavailable();
    }
    if (err instanceof NotWiredError || (isAppError(err) && err.status < 500)) return err;
    logger?.warn({ route: call.route, err: { name: errorName(err) } }, 'admin.dependency_failed');
    return new AppError('bad_gateway', { detail: INTERNAL_ADMIN_DETAILS.dependency });
  };

  /** Runs a write in the call's transaction, its event written before or after the action. */
  async function act(
    call: AdminCall,
    status: number,
    mode: RecordMode,
    run: (tx: AdminWriter, after: AfterCommit) => Promise<unknown>,
  ): Promise<unknown> {
    const tasks: (() => Promise<void>)[] = [];
    let began = false;
    let committing = false;
    const recordIn = async (tx: AdminWriter): Promise<void> => {
      try {
        await tx.record(callEvent(call, 'success', status, null), callDetails(call));
      } catch (err) {
        throw new AuditWriteError(err);
      }
    };
    let value: unknown;
    try {
      value = await store.transaction(async (tx) => {
        began = true;
        if (mode === 'before') await recordIn(tx);
        const result = await run(tx, (task) => tasks.push(task));
        if (mode === 'after') await recordIn(tx);
        committing = true;
        return result;
      });
    } catch (err) {
      if (err instanceof AuditWriteError || !began || committing) {
        call.recorded = true;
        throw err instanceof AuditWriteError ? err : new AuditWriteError(err);
      }
      throw err;
    }
    call.recorded = true;
    for (const task of tasks) {
      try {
        await task();
      } catch (err) {
        logger?.warn(
          { route: call.route, err: { name: errorName(err) } },
          'admin.after_commit_failed',
        );
      }
    }
    return value;
  }

  const route = (spec: RouteSpec): void => {
    app.route({
      method: spec.method,
      url: `${ADMIN_BASE}${spec.path}`,
      config: { adminQuery: spec.query ?? [] },
      // The target is known from the path before any check, so refusals name it too.
      onRequest: async (request: FastifyRequest) => {
        const call = request.adminCall;
        if (call === null) return;
        const params = (request.params ?? {}) as Record<string, string>;
        call.target = spec.target?.(params) ?? null;
        call.flag = spec.flag?.(params) ?? null;
      },
      preHandler: requireStaff(spec.minRole),
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const call = request.adminCall;
        if (call === null || call.staff === null) throw new TypeError('admin call without staff');
        const ctx: RouteContext = { request, call, staff: call.staff };
        const status = spec.status ?? 200;
        try {
          const body =
            spec.write === undefined
              ? await spec.read?.(ctx)
              : await act(call, status, spec.write.record, (tx, after) =>
                  (spec.write as NonNullable<RouteSpec['write']>).run(ctx, tx, after),
                );
          void reply.code(status);
          return body;
        } catch (err) {
          throw failure(err, call);
        }
      },
    });
  };

  const user = targetOf('user', 'usr', 'id');
  const query = (request: FastifyRequest): Record<string, unknown> =>
    (request.query ?? {}) as Record<string, unknown>;

  // Reads (support_ro and up).
  route({
    method: 'GET',
    path: '/users/:id',
    minRole: 'support_ro',
    target: user,
    read: ({ request, staff }) => service.user((request.params as { id: string }).id, staff),
  });
  route({
    method: 'GET',
    path: '/users',
    minRole: 'support_ro',
    query: ['email'],
    read: async ({ request, call, staff }) => {
      const { body, userId } = await service.lookupUser(query(request)['email'], staff);
      if (userId !== null) call.target = { type: 'user', id: userId };
      return body;
    },
  });
  route({
    method: 'GET',
    path: '/workspaces/:id',
    minRole: 'support_ro',
    target: targetOf('workspace', 'wsp', 'id'),
    read: ({ request, staff }) => service.workspace((request.params as { id: string }).id, staff),
  });
  route({
    method: 'GET',
    path: '/sessions/:id',
    minRole: 'support_ro',
    target: targetOf('session', 'ses', 'id'),
    read: ({ request }) => service.session((request.params as { id: string }).id),
  });
  route({
    method: 'GET',
    path: '/staff-audit',
    minRole: 'support_ro',
    query: ['limit', 'cursor', 'actor', 'target'],
    read: ({ request }) => service.staffAudit(query(request)),
  });

  // Writes (support_rw and up).
  route({
    method: 'POST',
    path: '/users/:id/revoke-tokens',
    minRole: 'support_rw',
    target: user,
    write: {
      record: 'before',
      run: ({ request, staff }, tx, after) =>
        service.revokeTokens(tx, (request.params as { id: string }).id, request.body, staff, after),
    },
  });
  route({
    method: 'POST',
    path: '/users/:id/disable',
    minRole: 'support_rw',
    target: user,
    write: {
      record: 'before',
      run: ({ request, staff }, tx, after) =>
        service.disableUser(tx, (request.params as { id: string }).id, staff, after),
    },
  });
  route({
    method: 'POST',
    path: '/sessions/:id/end',
    minRole: 'support_rw',
    target: targetOf('session', 'ses', 'id'),
    write: {
      record: 'before',
      run: ({ request }, tx) => service.endSession(tx, (request.params as { id: string }).id),
    },
  });
  route({
    method: 'POST',
    path: '/invites/:id/resend',
    minRole: 'support_rw',
    target: targetOf('invite', 'inv', 'id'),
    write: {
      record: 'before',
      run: ({ request, staff }) =>
        service.resendInvite((request.params as { id: string }).id, staff),
    },
  });
  route({
    method: 'POST',
    path: '/workspaces/:id/promotions',
    minRole: 'support_rw',
    target: targetOf('workspace', 'wsp', 'id'),
    write: {
      record: 'before',
      run: ({ request, staff }) =>
        service.grantPromotion((request.params as { id: string }).id, request.body, staff),
    },
  });
  const flagKey = (params: Record<string, string>): string => params['key'] ?? '';
  route({
    method: 'PUT',
    path: '/flags/:key',
    minRole: 'support_rw',
    flag: flagKey,
    write: {
      record: 'before',
      run: ({ request, staff }) =>
        service.putFlag((request.params as { key: string }).key, request.body, staff),
    },
  });
  route({
    method: 'DELETE',
    path: '/flags/:key',
    minRole: 'support_rw',
    flag: flagKey,
    write: {
      record: 'before',
      run: ({ request, staff }) =>
        service.deleteFlag((request.params as { key: string }).key, staff),
    },
  });
  route({
    method: 'POST',
    path: '/incidents',
    minRole: 'support_rw',
    status: 201,
    write: {
      record: 'after',
      run: async ({ request, call }) => {
        const incident = await service.createIncident(request.body);
        call.target = { type: 'incident', id: incident.id };
        return incident;
      },
    },
  });
  route({
    method: 'POST',
    path: '/incidents/:id/updates',
    minRole: 'support_rw',
    status: 201,
    target: targetOf('incident', 'inc', 'id'),
    write: {
      record: 'before',
      run: ({ request }) =>
        service.addIncidentUpdate((request.params as { id: string }).id, request.body),
    },
  });

  // Staff records (superadmin only, never one's own).
  const staffTarget = targetOf('staff_user', 'usr', 'userId');
  route({
    method: 'PUT',
    path: '/staff/:userId',
    minRole: 'superadmin',
    target: staffTarget,
    write: {
      record: 'before',
      run: ({ request, staff }, tx, after) =>
        service.putStaff(
          tx,
          (request.params as { userId: string }).userId,
          request.body,
          staff,
          after,
        ),
    },
  });
  route({
    method: 'DELETE',
    path: '/staff/:userId',
    minRole: 'superadmin',
    target: staffTarget,
    write: {
      record: 'before',
      run: ({ request, staff }, tx, after) =>
        service.disableStaff(tx, (request.params as { userId: string }).userId, staff, after),
    },
  });
};

/**
 * The admin plugin: hooks and routes for the whole instance it is registered on, which must be
 * the admin listener (`createAdminServer`).
 */
export const internalAdminPlugin: FastifyPluginAsync<InternalAdminOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-internal-admin',
});

/** What the admin listener needs. */
export interface AdminServerOptions extends InternalAdminOptions {
  /** ADMIN_ALLOWED_CIDRS. */
  allowedCidrs: readonly Cidr[];
  logger: Logger;
}

/**
 * The admin listener, not yet listening: its own Fastify instance with request ids, problem
 * responses and the admin plugin, whose socket drops connections from outside `allowedCidrs`.
 */
export async function createAdminServer(opts: AdminServerOptions): Promise<FastifyInstance> {
  const metrics = opts.metrics ?? noopMetrics;
  const app = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: opts.logger }),
  });
  const allowed = cidrMatcher(opts.allowedCidrs);
  app.server.prependListener('connection', (socket: Socket) => {
    if (allowed(socket.remoteAddress)) return;
    metrics.counter('admin_connections_refused_total').inc();
    socket.destroy();
  });
  app.decorate(LISTENER_MARK, true);
  await app.register(requestContextPlugin, { logger: opts.logger, metrics });
  await app.register(errorHandlerPlugin, { logger: opts.logger });
  await app.register(internalAdminPlugin, opts);
  return app;
}

/** Starts the admin listener on ADMIN_API_PORT when ADMIN_API_ENABLED; null when disabled. */
export async function startAdminServer(
  config: AdminConfig,
  opts: Omit<AdminServerOptions, 'allowedCidrs'>,
  host = '0.0.0.0',
): Promise<FastifyInstance | null> {
  if (!config.enabled) return null;
  const app = await createAdminServer({ ...opts, allowedCidrs: config.allowedCidrs });
  await app.listen({ port: config.port, host });
  return app;
}

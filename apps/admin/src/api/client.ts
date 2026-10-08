/**
 * The admin API client (B088), typed by the admin API's own bodies (B087, type-only imports from
 * `@centcom/api`).
 *
 * Every call:
 * - goes to the configured admin API base and nowhere else, with ids encoded into the path;
 * - carries `Authorization: Bearer <token>` (from memory) and `X-Admin-Reason`, plus
 *   `X-Admin-Ticket` when there is one. The reason is asked for (`hooks.reason()`) before anything
 *   is sent; when the staff member cancels, nothing is sent (ReasonCancelledError);
 * - omits cookies, caches and referrers, and follows no redirect;
 * - is tried once: nothing is retried, writes least of all.
 *
 * A 401 or 403 is reported to the hooks (sign out, or check the role again) before it is thrown.
 */
import type {
  AdminSession,
  AdminUser,
  AdminUserLookup,
  AdminWorkspace,
  DisableUserResult,
  FlagChangeResult,
  PromotionResult,
  RevokeTokensResult,
  StaffAuditPage,
} from '@centcom/api';
import { ADMIN_PATH } from '../config.js';
import { AdminApiError, errorFromResponse, networkError, ReasonCancelledError } from './errors.js';
import type { Reason } from './reason.js';

/** An incident as the admin API answers it (B086's StatusAdmin, passed through by B087). */
export interface Incident {
  id: string;
  title: string;
  status: IncidentStatus;
  started_at: string;
  resolved_at: string | null;
  component_ids: string[];
  updates: { at: string; text: string }[];
}

/** CT-STATUS incident statuses. */
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
];

/** What the client asks of the console. */
export interface ClientHooks {
  /** The access token, from memory; null when signed out. */
  token(): string | null;
  /** The reason for the call: the current one, or one the staff member gives now; null: cancelled. */
  reason(): Promise<Reason | null>;
  /** The API refused the token (401). */
  onUnauthorized?(error: AdminApiError): void;
  /** The API refused the call (403): the role may have changed. */
  onForbidden?(error: AdminApiError): void;
}

type Query = Record<string, string | number | undefined>;

/** The one network function the client uses (the browser's fetch by default). */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The admin API. */
export class AdminClient {
  readonly #base: string;

  constructor(
    base: string,
    private readonly hooks: ClientHooks,
    private readonly fetchImpl: Fetch = (url, init) => globalThis.fetch(url, init),
  ) {
    this.#base = base.replace(/\/+$/, '');
  }

  /** The URL of `path` (already encoded) under the admin API. */
  url(path: string, query: Query = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const search = params.toString();
    return `${this.#base}${ADMIN_PATH}${path}${search === '' ? '' : `?${search}`}`;
  }

  /** One call; see the module comment. */
  async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const token = this.hooks.token();
    if (token === null) {
      throw new AdminApiError(401, 'signed_out', 'You are signed out.', null, null);
    }
    const reason = await this.hooks.reason();
    if (reason === null) throw new ReasonCancelledError();
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-admin-reason': reason.reason,
    };
    if (reason.ticket !== null) headers['x-admin-ticket'] = reason.ticket;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    // Typed with `cache` spelled out: Node's RequestInit (in the test program) does not list it.
    const init: RequestInit & { cache: 'no-store' } = {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), init);
    } catch {
      throw networkError();
    }
    if (!res.ok) {
      const error = await errorFromResponse(res);
      if (res.status === 401) this.hooks.onUnauthorized?.(error);
      if (res.status === 403) this.hooks.onForbidden?.(error);
      throw error;
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new AdminApiError(
        res.status,
        'bad_response',
        'The admin API sent an unreadable answer.',
        null,
        res.headers.get('x-request-id'),
      );
    }
  }

  user(id: string): Promise<AdminUser> {
    return this.request('GET', `/users/${encodeURIComponent(id)}`);
  }

  lookupUser(email: string): Promise<AdminUserLookup> {
    return this.request('GET', '/users', { query: { email } });
  }

  workspace(id: string): Promise<AdminWorkspace> {
    return this.request('GET', `/workspaces/${encodeURIComponent(id)}`);
  }

  session(id: string): Promise<AdminSession> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  staffAudit(query: {
    limit?: number;
    cursor?: string;
    actor?: string;
    target?: string;
  }): Promise<StaffAuditPage> {
    return this.request('GET', '/staff-audit', { query });
  }

  revokeTokens(userId: string, device?: string): Promise<RevokeTokensResult> {
    return this.request('POST', `/users/${encodeURIComponent(userId)}/revoke-tokens`, {
      body: device === undefined ? {} : { device },
    });
  }

  disableUser(userId: string): Promise<DisableUserResult> {
    return this.request('POST', `/users/${encodeURIComponent(userId)}/disable`);
  }

  endSession(id: string): Promise<AdminSession> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/end`);
  }

  grantPromotion(workspaceId: string, promotionCodeId: string): Promise<PromotionResult> {
    return this.request('POST', `/workspaces/${encodeURIComponent(workspaceId)}/promotions`, {
      body: { promotion_code_id: promotionCodeId },
    });
  }

  putFlag(key: string, definition: Record<string, unknown>): Promise<FlagChangeResult> {
    return this.request('PUT', `/flags/${encodeURIComponent(key)}`, { body: definition });
  }

  deleteFlag(key: string): Promise<FlagChangeResult> {
    return this.request('DELETE', `/flags/${encodeURIComponent(key)}`);
  }

  createIncident(input: {
    title: string;
    component_ids: string[];
    status: IncidentStatus;
  }): Promise<Incident> {
    return this.request('POST', '/incidents', { body: input });
  }

  addIncidentUpdate(
    id: string,
    input: { text: string; status?: IncidentStatus },
  ): Promise<Incident> {
    return this.request('POST', `/incidents/${encodeURIComponent(id)}/updates`, { body: input });
  }
}

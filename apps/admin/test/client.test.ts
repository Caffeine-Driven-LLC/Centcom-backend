/**
 * The admin console's API client and helpers (B088), without React: where calls go and what they
 * carry (the reason on every one, the ticket when given, no cookies or referrer), nothing sent
 * without a reason or a token, problem+json mapped to AdminApiError, network failures, the 401 and
 * 403 hooks, no retries; and the reason, token and route helpers.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AdminApiError,
  AdminClient,
  parseRoute,
  pathOfId,
  reasonProblem,
  ReasonCancelledError,
  subjectOf,
  ticketProblem,
  toReason,
  type ClientHooks,
  type Fetch,
} from '../src/index.js';
import { API, FakeAdminApi, id, tokenFor } from './fake-api.js';

const REASON = { reason: 'Checking ticket SUP-1 about sign-in', ticket: 'SUP-1' };

function clientWith(
  fetchImpl: Fetch,
  over: Partial<ClientHooks> = {},
): { client: AdminClient; hooks: ClientHooks } {
  const hooks: ClientHooks = {
    token: () => 'the-token',
    reason: () => Promise.resolve(REASON),
    ...over,
  };
  return { client: new AdminClient(`${API}/`, hooks, fetchImpl), hooks };
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<Fetch>(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    ),
  );

describe('requests', () => {
  it('goes to the admin API only, with the token, reason, ticket and no cookies or referrer', async () => {
    const fetchImpl = respond(200, { ok: true });
    const { client } = clientWith(fetchImpl);
    await client.user('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W');
    await client.revokeTokens('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W');
    await client.staffAudit({ limit: 5, actor: undefined, target: '' });
    await client.putFlag('beta.banner', { type: 'bool' });
    const calls = fetchImpl.mock.calls.map(([url, init]) => ({ url, init }));
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/internal/admin/v1/users/usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W`,
      `${API}/internal/admin/v1/users/usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W/revoke-tokens`,
      `${API}/internal/admin/v1/staff-audit?limit=5`,
      `${API}/internal/admin/v1/flags/beta.banner`,
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer the-token',
        'x-admin-reason': REASON.reason,
        'x-admin-ticket': 'SUP-1',
      });
    }
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ device: 'dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W' }));
    expect(calls[1]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.headers).not.toHaveProperty('content-type');
  });

  it('encodes ids into the path, and sends no ticket header without a ticket', async () => {
    const fetchImpl = respond(200, {});
    const { client } = clientWith(fetchImpl, {
      reason: () => Promise.resolve({ reason: 'Looking into a refund', ticket: null }),
    });
    await client.user('../../v1/me?x=1#y');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/internal/admin/v1/users/..%2F..%2Fv1%2Fme%3Fx%3D1%23y`);
    expect(init?.headers).not.toHaveProperty('x-admin-ticket');
  });

  it('sends nothing when the reason is cancelled or no one is signed in', async () => {
    const fetchImpl = respond(200, {});
    const cancelled = clientWith(fetchImpl, { reason: () => Promise.resolve(null) }).client;
    await expect(cancelled.user('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).rejects.toBeInstanceOf(
      ReasonCancelledError,
    );
    const signedOut = clientWith(fetchImpl, { token: () => null }).client;
    await expect(signedOut.disableUser('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).rejects.toMatchObject({
      code: 'signed_out',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  it('maps problem+json to AdminApiError with its request id', async () => {
    const requestId = 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    const { client } = clientWith(
      respond(
        404,
        {
          type: 'x',
          title: 'Not found',
          status: 404,
          code: 'not_found',
          detail: 'There is no such record.',
          request_id: requestId,
        },
        { 'content-type': 'application/problem+json' },
      ),
    );
    const error = await client.user('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'not_found',
      title: 'Not found',
      detail: 'There is no such record.',
      requestId,
    });
  });

  it('falls back to the status and the X-Request-Id header for a body that is not a problem', async () => {
    const requestId = 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4X';
    const { client } = clientWith(
      respond(502, '<html>Bad gateway</html>', {
        'content-type': 'text/html',
        'x-request-id': requestId,
      }),
    );
    await expect(client.session('ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).rejects.toMatchObject({
      status: 502,
      code: 'server_error',
      detail: null,
      requestId,
    });
    const garbled = clientWith(
      respond(200, 'not json', { 'content-type': 'application/json' }),
    ).client;
    await expect(garbled.session('ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('reports a network failure as status 0, and never retries', async () => {
    const down = vi.fn<Fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    const { client } = clientWith(down);
    await expect(client.endSession('ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
    expect(down).toHaveBeenCalledTimes(1);
    const unavailable = respond(503, { code: 'service_unavailable', title: 'Unavailable' });
    await expect(
      clientWith(unavailable).client.disableUser('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W'),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('tells the console about 401 and 403 before throwing', async () => {
    const onUnauthorized = vi.fn();
    const onForbidden = vi.fn();
    const hooks = { onUnauthorized, onForbidden };
    await expect(
      clientWith(respond(401, { code: 'token_expired', title: 'Expired' }), hooks).client.user('x'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      clientWith(respond(403, { code: 'forbidden', title: 'Forbidden' }), hooks).client.user('x'),
    ).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onForbidden).toHaveBeenCalledTimes(1);
  });

  it('works against the fake API, typed by the admin API bodies', async () => {
    const api = new FakeAdminApi();
    const staff = api.addStaff('support_rw');
    const user = api.addUser({ email: 'bob@example.org' });
    const client = new AdminClient(
      API,
      { token: () => staff.token, reason: () => Promise.resolve(REASON) },
      api.fetch,
    );
    expect((await client.lookupUser('BOB@example.org')).data.map((u) => u.id)).toEqual([user.id]);
    expect((await client.user(user.id)).email).toBe('bob@example.org');
    expect(api.requests.every((r) => r.headers['x-admin-reason'] === REASON.reason)).toBe(true);
  });
});

describe('helpers', () => {
  it('checks reasons and tickets as the admin API does', () => {
    expect(reasonProblem('too short')).not.toBeNull();
    expect(reasonProblem('long enough now')).toBeNull();
    expect(reasonProblem('x'.repeat(501))).not.toBeNull();
    expect(reasonProblem(`line one${String.fromCharCode(10)}line two`)).not.toBeNull();
    expect(reasonProblem(`emoji ${String.fromCodePoint(0x1f600)} in it`)).not.toBeNull();
    expect(reasonProblem('Kunde möchte Rückerstattung')).toBeNull();
    expect(ticketProblem('')).toBeNull();
    expect(ticketProblem('JIRA-42/ops#3')).toBeNull();
    expect(ticketProblem('two words')).not.toBeNull();
    expect(toReason('  a reason given here  ', ' SUP-9 ')).toEqual({
      reason: 'a reason given here',
      ticket: 'SUP-9',
    });
    expect(toReason('a reason given here', '')).toEqual({
      reason: 'a reason given here',
      ticket: null,
    });
    expect(toReason('short', '')).toBeNull();
  });

  it('reads the user id of a staff token, and nothing else', () => {
    const userId = id('usr');
    expect(subjectOf(tokenFor(userId))).toBe(userId);
    expect(subjectOf(` ${tokenFor(userId)} `)).toBe(userId);
    expect(subjectOf(tokenFor('not-a-user'))).toBeNull();
    expect(subjectOf('cen_live_abc')).toBeNull();
    expect(subjectOf('a.b.c')).toBeNull();
    expect(subjectOf('a.!!!.c')).toBeNull();
  });

  it('routes ids to their pages, and anything else to not found', () => {
    const u = id('usr');
    const w = id('wsp');
    const s = id('ses');
    expect(parseRoute('/')).toEqual({ page: 'lookup' });
    expect(parseRoute(`/users/${u}`)).toEqual({ page: 'user', id: u });
    expect(parseRoute(`/workspaces/${w}`)).toEqual({ page: 'workspace', id: w });
    expect(parseRoute(`/sessions/${s}`)).toEqual({ page: 'session', id: s });
    expect(parseRoute('/flags')).toEqual({ page: 'flags' });
    expect(parseRoute('/incidents/')).toEqual({ page: 'incidents' });
    expect(parseRoute('/staff-audit')).toEqual({ page: 'staff-audit' });
    expect(parseRoute(`/users/${w}`)).toEqual({ page: 'not-found' });
    expect(parseRoute('/users/alice@example.com')).toEqual({ page: 'not-found' });
    expect(parseRoute('/sessions/x/y')).toEqual({ page: 'not-found' });
    expect(pathOfId(w)).toBe(`/workspaces/${w}`);
    expect(pathOfId('javascript:alert(1)')).toBeNull();
  });
});

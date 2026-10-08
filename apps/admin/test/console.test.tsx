/**
 * The admin console in jsdom (B088) against the fake admin API, which sees every request (it is the
 * global fetch):
 *
 * - sign-in: the reason dialog comes before the first call and cancelling it sends nothing; the
 *   role comes from the API's answer, never the token; non-staff and non-tokens are refused;
 * - every page with fixtures, and every write, with destructive ones behind the typed target id;
 * - every request carries X-Admin-Reason and goes to the admin API only;
 * - support_ro sees no write control and never sends a write;
 * - the token is never in storage, cookies, the URL or the console; 15 minutes idle signs out;
 * - API strings are rendered as text; 401, 403 (role refresh), 5xx (no retry) handling;
 * - the smoke run: sign in, look up, workspace detail, set a flag;
 * - accessibility basics: labels, one h1 and a main landmark per page, keyboard use.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/App.js';
import { IDLE_SIGN_OUT_MS } from '../src/config.js';
import { API, FakeAdminApi, id, tokenFor } from './fake-api.js';
import { follow, REASON, renderConsole, signIn } from './harness.js';

/** Staff of `role`, Alice (with a device, in a workspace with Bob and a live session). */
function world(role: 'support_ro' | 'support_rw' | 'superadmin' = 'support_rw') {
  const api = new FakeAdminApi();
  const staff = api.addStaff(role);
  const alice = api.addUser({ email: 'alice@example.com', display_name: 'Alice Example' });
  const device = {
    id: id('dev'),
    name: 'Work laptop',
    platform: 'linux',
    created_at: '2026-01-03T00:00:00.000Z',
    last_seen_at: null,
    revoked_at: null,
  };
  alice.devices.push(device);
  const bob = api.addUser({ email: 'bob@example.org', display_name: 'Bob Builder' });
  const ws = api.addWorkspace([alice, bob]);
  alice.memberships.push({
    member: ws.members[0]?.member ?? id('mem'),
    workspace: ws.id,
    role: 'owner',
    joined_at: '2026-01-05T00:00:00.000Z',
  });
  const session = api.addSession(ws.id);
  return { api, staff, alice, bob, device, ws, session };
}

const WRITE_BUTTONS =
  /^(Revoke|Disable|End session|Set flag|Delete flag|Open incident|Add update|Grant promotion)/;

describe('sign-in and the reason', () => {
  it('asks for a reason before the first call; cancelling sends nothing', async () => {
    const { api, staff } = world();
    const { user } = renderConsole(api);
    await signIn(user, staff.token, null);
    expect(api.requests).toEqual([]);
    expect(await screen.findByText(MESSAGES.noReason)).toBeDefined();
    await signIn(user, staff.token, REASON, 'SUP-42');
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.headers).toMatchObject({
      'x-admin-reason': REASON,
      'x-admin-ticket': 'SUP-42',
    });
    expect(screen.getByText('support_rw')).toBeDefined();
  });

  it('takes the role from the API, not from the token', async () => {
    const api = new FakeAdminApi();
    const staff = api.addStaff('support_ro', {
      role: 'superadmin',
      staff_role: 'superadmin',
      scp: 'admin superadmin',
    });
    const alice = api.addUser();
    const { user } = renderConsole(api, { path: `/users/${alice.id}` });
    await signIn(user, staff.token);
    expect(await screen.findByText(alice.email)).toBeDefined();
    expect(screen.getByText('support_ro')).toBeDefined();
    expect(screen.queryAllByRole('button', { name: WRITE_BUTTONS })).toEqual([]);
  });

  it('refuses what is not a staff token, and an account that is not staff', async () => {
    const { api } = world();
    const { user } = renderConsole(api);
    await user.click(screen.getByLabelText('Staff access token'));
    await user.paste('cen_live_0123456789abcdef0123456789abcdef');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(MESSAGES.notAToken)).toBeDefined();
    expect(api.requests).toEqual([]);

    const outsider = api.addUser();
    const token = tokenFor(outsider.id);
    api.tokens.set(token, outsider.id);
    await user.click(screen.getByLabelText('Staff access token'));
    await user.paste(token);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Reason/), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Use this reason' }));
    expect(await screen.findByText(MESSAGES.notPermitted)).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });
});

describe('pages and writes (support_rw)', () => {
  it(
    'looks up, shows each page, and sends each write once, every request with the reason',
    { timeout: 60_000 },
    async () => {
      const { api, staff, alice, device, ws, session } = world();
      const { user } = renderConsole(api);
      await signIn(user, staff.token, REASON, 'OPS-7');

      // Look up by address (case-insensitive), then the user's page.
      await user.type(screen.getByLabelText(/e-mail address/), 'ALICE@example.com');
      await user.click(screen.getByRole('button', { name: 'Look up' }));
      await follow(user, alice.id);
      expect(
        await screen.findByRole('heading', { level: 1, name: `User ${alice.id}` }),
      ).toBeDefined();
      expect(screen.getByText('alice@example.com')).toBeDefined();
      expect(screen.getByText('Work laptop')).toBeDefined();
      expect(window.location.pathname).toBe(`/users/${alice.id}`);
      expect(window.location.href).not.toContain('alice@example.com');

      // A destructive action needs the exact target id.
      await user.click(screen.getByRole('button', { name: 'Revoke all tokens' }));
      const confirm = screen.getByRole('dialog', { name: 'Revoke all tokens' });
      const go = within(confirm).getByRole('button', { name: 'Revoke all tokens' });
      await user.type(within(confirm).getByRole('textbox'), alice.id.slice(0, -1));
      expect((go as HTMLButtonElement).disabled).toBe(true);
      await user.type(within(confirm).getByRole('textbox'), 'X');
      expect((go as HTMLButtonElement).disabled).toBe(true);
      await user.clear(within(confirm).getByRole('textbox'));
      await user.type(within(confirm).getByRole('textbox'), alice.id);
      expect((go as HTMLButtonElement).disabled).toBe(false);
      await user.click(go);
      expect(await screen.findByText(/Refresh tokens revoked: 2/)).toBeDefined();

      await user.click(screen.getByRole('button', { name: `Revoke device ${device.id}` }));
      await user.type(screen.getByRole('textbox', { name: /to confirm/ }), device.id);
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: `Revoke device ${device.id}`,
        }),
      );
      expect(await screen.findByText('Device revoked.')).toBeDefined();

      await user.click(screen.getByRole('button', { name: 'Disable sign-in' }));
      await user.type(screen.getByRole('textbox', { name: /to confirm/ }), alice.id);
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable sign-in' }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Disable sign-in' })).toBeNull(),
      );

      // The workspace, from the membership.
      await follow(user, ws.id);
      expect(
        await screen.findByRole('heading', { level: 1, name: `Workspace ${ws.id}` }),
      ).toBeDefined();
      expect(screen.getByText('team')).toBeDefined();
      expect(screen.getByText('bob@example.org')).toBeDefined();
      expect(screen.getByText('max_seats')).toBeDefined();
      await user.type(screen.getByLabelText('Promotion code id'), 'promo_1Pq2Rs3');
      await user.click(screen.getByRole('button', { name: 'Grant promotion' }));
      expect(await screen.findByText('Granted: pro, active.')).toBeDefined();

      // A session by id from the lookup box.
      await follow(user, 'Look up');
      await user.type(screen.getByLabelText(/e-mail address/), session.id);
      await user.click(screen.getByRole('button', { name: 'Look up' }));
      expect(
        await screen.findByRole('heading', { level: 1, name: `Session ${session.id}` }),
      ).toBeDefined();
      await user.click(screen.getByRole('button', { name: 'End session' }));
      await user.type(screen.getByRole('textbox', { name: /to confirm/ }), session.id);
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'End session' }),
      );
      expect(await screen.findByText('ended')).toBeDefined();

      // Flags.
      await follow(user, 'Flags');
      await user.type(screen.getByLabelText('Flag key'), 'beta.banner');
      await user.click(screen.getByRole('button', { name: 'Set flag' }));
      expect(await screen.findByText('Flag beta.banner set (revision 1).')).toBeDefined();
      await user.click(screen.getByRole('button', { name: 'Delete flag' }));
      await user.type(screen.getByRole('textbox', { name: /to confirm/ }), 'beta.banner');
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete flag' }),
      );
      expect(await screen.findByText('Flag beta.banner deleted (revision 2).')).toBeDefined();

      // Incidents.
      await follow(user, 'Incidents');
      await user.type(screen.getByLabelText(/^Title/), 'Elevated latency');
      await user.type(screen.getByLabelText(/^Components/), 'api, relay-eu');
      await user.click(screen.getByRole('button', { name: 'Open incident' }));
      const incidentId = [...api.incidents.keys()][0] ?? '';
      expect(await screen.findByText(incidentId)).toBeDefined();
      await user.type(screen.getByLabelText('Incident id'), incidentId);
      await user.type(screen.getByLabelText(/^Update/), 'We are looking into it.');
      await user.selectOptions(screen.getByLabelText('New status'), 'identified');
      await user.click(screen.getByRole('button', { name: 'Add update' }));
      await waitFor(() => expect(api.incidents.get(incidentId)?.status).toBe('identified'));

      // The staff audit shows the calls with their reason.
      await follow(user, 'Staff audit');
      expect((await screen.findAllByText(REASON)).length).toBeGreaterThan(5);

      expect(
        api
          .writes()
          .map(
            (r) =>
              `${r.method} ${new URL(r.url).pathname.replace(/\/[a-z]{3}_[0-9A-Z]{26}/g, '/:id')}`,
          ),
      ).toEqual([
        'POST /internal/admin/v1/users/:id/revoke-tokens',
        'POST /internal/admin/v1/users/:id/revoke-tokens',
        'POST /internal/admin/v1/users/:id/disable',
        'POST /internal/admin/v1/workspaces/:id/promotions',
        'POST /internal/admin/v1/sessions/:id/end',
        'PUT /internal/admin/v1/flags/beta.banner',
        'DELETE /internal/admin/v1/flags/beta.banner',
        'POST /internal/admin/v1/incidents',
        'POST /internal/admin/v1/incidents/:id/updates',
      ]);
      expect(api.writes()[1]?.body).toEqual({ device: device.id });
      // Network level: every request carried the reason and ticket, to the admin API only.
      expect(api.requests.length).toBeGreaterThan(15);
      for (const r of api.requests) {
        expect(r.headers['x-admin-reason'], r.url).toBe(REASON);
        expect(r.headers['x-admin-ticket'], r.url).toBe('OPS-7');
        expect(r.url.startsWith(`${API}/internal/admin/v1/`), r.url).toBe(true);
      }
    },
  );

  it('keeps a destructive button disabled until the exact id is typed, and cancels cleanly', async () => {
    const { api, staff, alice } = world();
    const { user } = renderConsole(api, { path: `/users/${alice.id}` });
    await signIn(user, staff.token);
    await user.click(await screen.findByRole('button', { name: 'Disable sign-in' }));
    const dialog = screen.getByRole('dialog', { name: 'Disable sign-in' });
    const button = within(dialog).getByRole('button', {
      name: 'Disable sign-in',
    }) as HTMLButtonElement;
    for (const typed of [alice.id.toLowerCase(), ` ${alice.id}`, alice.email]) {
      await user.clear(within(dialog).getByRole('textbox'));
      await user.type(within(dialog).getByRole('textbox'), typed);
      expect(button.disabled, typed).toBe(true);
      await user.keyboard('{Enter}');
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.writes()).toEqual([]);
  });

  it('shows a failed write inline with its request id, and never retries it', async () => {
    const { api, staff, session } = world();
    const { user } = renderConsole(api, { path: `/sessions/${session.id}` });
    await signIn(user, staff.token);
    await screen.findByRole('button', { name: 'End session' });
    api.failWith = { status: 502, code: 'bad_gateway', title: 'Bad gateway' };
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await user.type(screen.getByRole('textbox', { name: /to confirm/ }), session.id);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'End session' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Bad gateway');
    expect(alert.textContent).toMatch(/Request id: req_/);
    expect(api.writes()).toHaveLength(1);
  });
});

describe('support_ro', () => {
  it('sees no write control on any page and never sends a write', { timeout: 60_000 }, async () => {
    const { api, staff, alice, ws, session } = world('support_ro');
    const { user } = renderConsole(api);
    await signIn(user, staff.token);
    for (const path of [
      `/users/${alice.id}`,
      `/workspaces/${ws.id}`,
      `/sessions/${session.id}`,
      '/flags',
      '/incidents',
      '/staff-audit',
      '/',
    ]) {
      act(() => {
        window.history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await screen.findByRole('heading', { level: 1 });
      await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
      expect(screen.queryAllByRole('button', { name: WRITE_BUTTONS }), path).toEqual([]);
      expect(screen.queryByLabelText('Promotion code id'), path).toBeNull();
    }
    expect(screen.getByText('support_ro')).toBeDefined();
    expect(api.writes()).toEqual([]);
    expect(api.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('the token', () => {
  it('is never in storage, cookies, the URL or console output', { timeout: 60_000 }, async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const { api, staff, alice, ws } = world();
    const { user } = renderConsole(api);
    await signIn(user, staff.token);
    expect(
      (screen.queryByLabelText('Staff access token') as HTMLTextAreaElement | null)?.value ?? '',
    ).toBe('');
    await user.type(screen.getByLabelText(/e-mail address/), alice.id);
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    await screen.findByText(alice.email);
    await follow(user, ws.id);
    await screen.findByText('bob@example.org');
    await follow(user, 'Staff audit');
    await screen.findAllByText(REASON);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(window.location.href).not.toContain(staff.token);
    expect(document.body.innerHTML).not.toContain(staff.token);
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(staff.token);
    }
    for (const spy of spies) spy.mockRestore();
  });

  it('is dropped after 15 minutes without activity, and the reason with it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, staff } = world();
    const { user } = renderConsole(api, { fakeTimers: true });
    await signIn(user, staff.token);
    expect(IDLE_SIGN_OUT_MS).toBe(15 * 60 * 1000);
    act(() => vi.advanceTimersByTime(14 * 60 * 1000));
    await user.keyboard('{Shift}');
    act(() => vi.advanceTimersByTime(14 * 60 * 1000));
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined();
    act(() => vi.advanceTimersByTime(60 * 1000 + 1));
    expect(await screen.findByText(MESSAGES.idle)).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    const before = api.requests.length;
    // Signing in again asks for a reason again.
    await signIn(user, staff.token, 'A new reason for a new sign-in');
    expect(api.requests.slice(before).map((r) => r.headers['x-admin-reason'])).toEqual([
      'A new reason for a new sign-in',
    ]);
  });
});

describe('API values are text', () => {
  it('renders HTML and script in any field as text', { timeout: 60_000 }, async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>';
    const { api, staff } = world();
    const evil = api.addUser({ display_name: payload, email: `<svg onload=alert(3)>@example.com` });
    evil.devices.push({
      id: id('dev'),
      name: payload,
      platform: '<i>x</i>',
      created_at: 'not a date',
      last_seen_at: null,
      revoked_at: null,
    });
    const { user } = renderConsole(api, { path: `/users/${evil.id}` });
    await signIn(user, staff.token, `${REASON} <script>alert(4)</script>`);
    expect((await screen.findAllByText(payload)).length).toBe(2);
    expect(screen.getByText('<svg onload=alert(3)>@example.com')).toBeDefined();
    expect(screen.getByText('not a date')).toBeDefined();
    expect(document.body.querySelectorAll('img, script, svg, b, i')).toHaveLength(0);
    await follow(user, 'Staff audit');
    expect(
      (await screen.findAllByText(`${REASON} <script>alert(4)</script>`)).length,
    ).toBeGreaterThan(0);
    expect(document.body.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('401 and 403', () => {
  it('signs out when the API stops accepting the token', async () => {
    const { api, staff, alice } = world();
    const { user } = renderConsole(api);
    await signIn(user, staff.token);
    api.tokens.delete(staff.token);
    await user.type(screen.getByLabelText(/e-mail address/), alice.id);
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(MESSAGES.unauthorized)).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it(
    'checks the role again on a 403: a lower role hides writes, no role signs out',
    { timeout: 60_000 },
    async () => {
      const { api, staff, alice } = world();
      const { user } = renderConsole(api, { path: `/users/${alice.id}` });
      await signIn(user, staff.token);
      await screen.findByRole('button', { name: 'Revoke all tokens' });
      api.setRole(staff.userId, 'support_ro');
      await user.click(screen.getByRole('button', { name: 'Revoke all tokens' }));
      await user.type(screen.getByRole('textbox', { name: /to confirm/ }), alice.id);
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke all tokens' }),
      );
      await waitFor(() => expect(screen.getByText('support_ro')).toBeDefined());
      expect(screen.queryAllByRole('button', { name: WRITE_BUTTONS })).toEqual([]);

      api.setRole(staff.userId, null);
      await follow(user, 'Staff audit');
      expect(await screen.findByText(MESSAGES.notPermitted)).toBeDefined();
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    },
  );
});

describe('smoke: sign in, look up, workspace detail, set a flag', () => {
  it('runs end to end', async () => {
    const { api, staff, ws } = world();
    const { user } = renderConsole(api);
    await signIn(user, staff.token);
    await user.type(screen.getByLabelText(/e-mail address/), 'bob@example.org');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    const bobId = [...api.users.values()].find((u) => u.email === 'bob@example.org')?.id ?? '';
    await follow(user, bobId);
    await screen.findByRole('heading', { level: 1, name: `User ${bobId}` });
    act(() => {
      window.history.pushState(null, '', `/workspaces/${ws.id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByText('Acme')).toBeDefined();
    await follow(user, 'Flags');
    await user.type(screen.getByLabelText('Flag key'), 'ops.banner');
    await user.click(screen.getByRole('button', { name: 'Set flag' }));
    expect(await screen.findByText('Flag ops.banner set (revision 1).')).toBeDefined();
    expect(api.flags.get('ops.banner')).toEqual({
      type: 'bool',
      value: true,
      default: false,
      public: true,
    });
  });
});

describe('accessibility basics', () => {
  it(
    'labels every control, has one h1 and a main landmark per page, and works by keyboard',
    { timeout: 60_000 },
    async () => {
      const { api, staff, alice, ws, session } = world();
      const { user } = renderConsole(api);
      // The sign-in field has focus at once; Tab reaches the button.
      expect(document.activeElement).toBe(screen.getByLabelText('Staff access token'));
      await signIn(user, staff.token);
      for (const path of [
        '/',
        `/users/${alice.id}`,
        `/workspaces/${ws.id}`,
        `/sessions/${session.id}`,
        '/flags',
        '/incidents',
        '/staff-audit',
      ]) {
        act(() => {
          window.history.pushState(null, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
        await screen.findByRole('heading', { level: 1 });
        await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
        expect(screen.getAllByRole('heading', { level: 1 }), path).toHaveLength(1);
        expect(screen.getByRole('main'), path).toBeDefined();
        for (const control of document.querySelectorAll('input, textarea, select')) {
          expect(
            (control as HTMLInputElement).labels?.length ?? 0,
            `${path} ${control.id}`,
          ).toBeGreaterThan(0);
        }
        for (const button of screen.getAllByRole('button')) {
          expect(button.textContent?.trim(), path).not.toBe('');
        }
        for (const link of screen.getAllByRole('link')) {
          expect(link.getAttribute('href'), path).toMatch(/^[/#]/);
        }
      }
      // Keyboard: skip link, then the navigation, which works with Enter.
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      await user.tab();
      expect(document.activeElement?.textContent).toBe('Skip to content');
      await user.tab();
      expect(document.activeElement?.textContent).toBe('Look up');
      await user.tab();
      await user.keyboard('{Enter}');
      expect(await screen.findByRole('heading', { level: 1, name: 'Feature flags' })).toBeDefined();
      // The reason dialog is labelled, takes focus, and closes on Escape keeping the reason.
      await user.click(screen.getByRole('button', { name: 'Change reason' }));
      const dialog = screen.getByRole('dialog', { name: 'Why are you looking?' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Reason/));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByText(`Reason: ${REASON}`, { exact: false })).toBeDefined();
    },
  );
});

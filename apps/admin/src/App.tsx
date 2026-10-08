/**
 * The admin console (B088): sign-in, the reason dialog, the pages, and the rules around them.
 *
 * - **Token:** in memory only (a ref): never in storage, cookies, URLs or console output. It is
 *   dropped on sign-out, on a 401, on a refusal of the staff member, and after 15 minutes without
 *   activity (pointer, keyboard, wheel or touch).
 * - **Role:** from the admin API's answer about the signed-in user (`staff_role`), never from the
 *   token. A 403 makes the console ask again: a lower role hides the write controls; no role signs
 *   out with "not permitted".
 * - **Reason:** every call carries one. The first call asks for it (ReasonDialog); cancelling sends
 *   nothing. It stays for the rest of the sign-in until changed, and goes on sign-out.
 * - **Writes:** shown to support_rw and superadmin only, sent once (no retries), destructive ones
 *   after typing the target id.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AdminClient, type ClientHooks, type Fetch } from './api/client.js';
import { AdminApiError, ReasonCancelledError } from './api/errors.js';
import type { Reason } from './api/reason.js';
import { subjectOf } from './api/token.js';
import { IDLE_SIGN_OUT_MS, type ConsoleConfig } from './config.js';
import { FlagsPage } from './pages/FlagsPage.js';
import { IncidentsPage } from './pages/IncidentsPage.js';
import { LookupPage } from './pages/LookupPage.js';
import { SessionPage } from './pages/SessionPage.js';
import { StaffAuditPage } from './pages/StaffAuditPage.js';
import { UserPage } from './pages/UserPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';
import { parseRoute, type Route } from './router.js';
import { ConsoleContext, Link, type StaffSession } from './ui/common.js';
import { ReasonDialog } from './ui/dialogs.js';
import { SignIn } from './ui/SignIn.js';

/** What the staff member is told when the console signs them out. */
export const MESSAGES = Object.freeze({
  idle: 'You were signed out after 15 minutes without activity.',
  unauthorized: 'The admin API no longer accepts your token. Sign in again.',
  notPermitted: 'Your account is not permitted to use the admin console.',
  signedOut: 'You signed out.',
  notAToken: 'That is not a staff access token.',
  rejected: 'The admin API did not accept that token.',
  noReason: 'No reason was given, so nothing was sent.',
} as const);

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

const isAdminRole = (role: unknown): role is StaffSession['role'] =>
  role === 'support_ro' || role === 'support_rw' || role === 'superadmin';

/** The page for `route`. */
function page(route: Route, search: string): ReactNode {
  switch (route.page) {
    case 'lookup':
      return <LookupPage />;
    case 'user':
      return <UserPage key={route.id} id={route.id} />;
    case 'workspace':
      return <WorkspacePage key={route.id} id={route.id} />;
    case 'session':
      return <SessionPage key={route.id} id={route.id} />;
    case 'flags':
      return <FlagsPage />;
    case 'incidents':
      return <IncidentsPage />;
    case 'staff-audit': {
      const target = new URLSearchParams(search).get('target');
      return (
        <StaffAuditPage
          initialTarget={
            target !== null && /^[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}$/.test(target) ? target : null
          }
        />
      );
    }
    case 'not-found':
      return (
        <>
          <h1>Not found</h1>
          <p>
            There is no such page. <Link to="/">Look something up</Link>.
          </p>
        </>
      );
  }
}

export function App({ config, fetchImpl }: { config: ConsoleConfig; fetchImpl?: Fetch }) {
  const idleMs = config.idleMs ?? IDLE_SIGN_OUT_MS;
  const tokenRef = useRef<string | null>(null);
  const reasonRef = useRef<Reason | null>(null);
  const sessionRef = useRef<StaffSession | null>(null);
  const pendingReason = useRef<((reason: Reason | null) => void)[]>([]);
  const refreshing = useRef(false);

  const [session, setSessionState] = useState<StaffSession | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [dialog, setDialog] = useState<'ask' | 'change' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }));
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  const setSession = useCallback((next: StaffSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  /** The current reason, or one the staff member gives now (null when they cancel). */
  const askReason = useCallback((): Promise<Reason | null> => {
    if (reasonRef.current !== null) return Promise.resolve(reasonRef.current);
    return new Promise((resolve) => {
      pendingReason.current.push(resolve);
      setDialog('ask');
    });
  }, []);

  const reasonDone = (given: Reason | null) => {
    if (given !== null) {
      reasonRef.current = given;
      setReason(given);
    }
    setDialog(null);
    const waiting = pendingReason.current;
    pendingReason.current = [];
    for (const resolve of waiting) resolve(given ?? reasonRef.current);
  };

  const signOut = useCallback(
    (message: string) => {
      tokenRef.current = null;
      reasonRef.current = null;
      setReason(null);
      setSession(null);
      setNotice(message);
      setDialog(null);
      const waiting = pendingReason.current;
      pendingReason.current = [];
      for (const resolve of waiting) resolve(null);
    },
    [setSession],
  );

  const hooks = useRef<Pick<ClientHooks, 'onUnauthorized' | 'onForbidden'>>({});
  const [client] = useState(
    () =>
      new AdminClient(
        config.apiBase,
        {
          token: () => tokenRef.current,
          reason: askReason,
          onUnauthorized: (e) => hooks.current.onUnauthorized?.(e),
          onForbidden: (e) => hooks.current.onForbidden?.(e),
        },
        fetchImpl,
      ),
  );
  // Asks the API for the signed-in user's role, without the 403 hook (no loop).
  const [roleClient] = useState(
    () =>
      new AdminClient(
        config.apiBase,
        { token: () => tokenRef.current, reason: askReason },
        fetchImpl,
      ),
  );

  hooks.current = {
    onUnauthorized: () => signOut(MESSAGES.unauthorized),
    onForbidden: () => {
      const current = sessionRef.current;
      if (current === null || refreshing.current) return;
      refreshing.current = true;
      roleClient
        .user(current.userId)
        .then(
          (me) => {
            if (!isAdminRole(me.staff_role)) signOut(MESSAGES.notPermitted);
            else if (me.staff_role !== sessionRef.current?.role)
              setSession({ ...current, role: me.staff_role });
          },
          (error: unknown) => {
            if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
              signOut(MESSAGES.notPermitted);
            }
          },
        )
        .finally(() => {
          refreshing.current = false;
        });
    },
  };

  const signIn = async (token: string): Promise<string | null> => {
    const userId = subjectOf(token);
    if (userId === null) return MESSAGES.notAToken;
    const probe = new AdminClient(
      config.apiBase,
      { token: () => token, reason: askReason },
      fetchImpl,
    );
    try {
      const me = await probe.user(userId);
      if (!isAdminRole(me.staff_role)) return MESSAGES.notPermitted;
      tokenRef.current = token;
      setNotice(null);
      setSession({ userId, role: me.staff_role });
      return null;
    } catch (error) {
      reasonRef.current = null;
      setReason(null);
      if (error instanceof ReasonCancelledError) return MESSAGES.noReason;
      if (error instanceof AdminApiError && error.status === 401) return MESSAGES.rejected;
      if (error instanceof AdminApiError && error.status === 403) return MESSAGES.notPermitted;
      if (error instanceof AdminApiError) {
        return error.requestId === null
          ? error.title
          : `${error.title} (request ${error.requestId})`;
      }
      return 'Sign-in failed.';
    }
  };

  // Idle sign-out.
  useEffect(() => {
    if (session === null) return undefined;
    let timer = setTimeout(() => signOut(MESSAGES.idle), idleMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => signOut(MESSAGES.idle), idleMs);
    };
    for (const event of ACTIVITY) window.addEventListener(event, bump, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY) window.removeEventListener(event, bump);
    };
  }, [session === null, idleMs, signOut]);

  // Back and forward.
  useEffect(() => {
    const onPop = () =>
      setLocation({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (theme === null) delete document.documentElement.dataset['theme'];
    else document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    const url = new URL(path, window.location.origin);
    setLocation({ pathname: url.pathname, search: url.search });
  }, []);

  const reasonDialog =
    dialog === null ? null : (
      <ReasonDialog initial={dialog === 'change' ? reason : null} onDone={reasonDone} />
    );

  if (session === null) {
    return (
      <>
        <SignIn notice={notice} onSignIn={signIn} />
        {reasonDialog}
      </>
    );
  }

  const canWrite = session.role === 'support_rw' || session.role === 'superadmin';
  return (
    <ConsoleContext.Provider value={{ client, session, canWrite, navigate }}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header>
        <p className="brand">Centcom admin</p>
        <nav aria-label="Main">
          <ul>
            <li>
              <Link to="/">Look up</Link>
            </li>
            <li>
              <Link to="/flags">Flags</Link>
            </li>
            <li>
              <Link to="/incidents">Incidents</Link>
            </li>
            <li>
              <Link to="/staff-audit">Staff audit</Link>
            </li>
          </ul>
        </nav>
        <p className="who">
          <code>{session.userId}</code> <span className="role">{session.role}</span>
        </p>
        <p className="reason">
          Reason: {reason?.reason ?? 'none yet'}
          {reason?.ticket ? ` (${reason.ticket})` : null}{' '}
          <button type="button" onClick={() => setDialog('change')}>
            Change reason
          </button>
        </p>
        <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
        <button type="button" onClick={() => signOut(MESSAGES.signedOut)}>
          Sign out
        </button>
      </header>
      <main id="main" tabIndex={-1}>
        {page(parseRoute(location.pathname), location.search)}
      </main>
      {reasonDialog}
    </ConsoleContext.Provider>
  );
}

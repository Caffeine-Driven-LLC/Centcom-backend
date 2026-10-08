/**
 * What every page shares (B088): the console context (client, who is signed in, navigation), links,
 * loading, error notices and value formatting. Server values are always rendered as text.
 */
import type { StaffRole } from '@centcom/api';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { AdminClient } from '../api/client.js';
import { AdminApiError, ReasonCancelledError } from '../api/errors.js';
import { pathOfId } from '../router.js';

/** The signed-in staff member. */
export interface StaffSession {
  userId: string;
  /** From the admin API's answer about this user, never from the token. */
  role: StaffRole;
}

/** What pages get from the console. */
export interface ConsoleContextValue {
  client: AdminClient;
  session: StaffSession;
  /** support_rw and superadmin. */
  canWrite: boolean;
  navigate(path: string): void;
}

export const ConsoleContext = createContext<ConsoleContextValue | null>(null);

/** The console context; pages render only inside it. */
export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (value === null) throw new Error('useConsole outside the console');
  return value;
}

/** An in-app link. */
export function Link({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useConsole();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  );
}

/** An id: a link to its page when it is a user, workspace or session id, else plain text. */
export function IdText({ id }: { id: string | null | undefined }) {
  if (id === null || id === undefined) return <span className="muted">none</span>;
  const path = pathOfId(id);
  return path === null ? (
    <code>{id}</code>
  ) : (
    <Link to={path}>
      <code>{id}</code>
    </Link>
  );
}

/** A time as the API gives it (RFC 3339), shown in UTC. */
export function Time({ at }: { at: string | null | undefined }) {
  if (at === null || at === undefined) return <span className="muted">never</span>;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <span>{at}</span>;
  return <time dateTime={at}>{date.toISOString().replace('T', ' ').slice(0, 19)} UTC</time>;
}

/** A failed call, as the staff member sees it: the problem's title and detail, and its request id. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error instanceof ReasonCancelledError) {
    return (
      <p className="notice" role="status">
        No reason was given, so nothing was sent.
      </p>
    );
  }
  if (error instanceof AdminApiError) {
    return (
      <div className="error" role="alert">
        <p>
          <strong>{error.title}</strong>
          {error.detail === null ? null : ` ${error.detail}`}
        </p>
        {error.requestId === null ? null : (
          <p className="muted">
            Request id: <code>{error.requestId}</code>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="error" role="alert">
      <p>
        <strong>Something went wrong in the console.</strong>
      </p>
    </div>
  );
}

/** The state of a read. */
export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/** Runs `load` when `key` changes (and on reload); reads only, never retried by itself. */
export function useLoad<T>(load: (client: AdminClient) => Promise<T>, key: string): Loaded<T> {
  const { client } = useConsole();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    load(client).then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (live) setState({ data: null, error, loading: false });
      },
    );
    return () => {
      live = false;
    };
    // `load` is a fresh closure every render; the key says when the read changes.
  }, [client, key, round]);
  const reload = useCallback(() => setRound((r) => r + 1), []);
  return { ...state, reload };
}

/** The read's body, its loading line or its error. */
export function LoadedView<T>({
  loaded,
  children,
}: {
  loaded: Loaded<T>;
  children: (data: T) => ReactNode;
}) {
  if (loaded.loading) return <p role="status">Loading…</p>;
  if (loaded.data === null) {
    return (
      <>
        <ErrorNotice error={loaded.error} />
        <button type="button" onClick={loaded.reload}>
          Try again
        </button>
      </>
    );
  }
  return <>{children(loaded.data)}</>;
}

/** A field list: term and value pairs. */
export function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="fields">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A value of unknown shape (limits, usage) as text. */
export function Plain({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">none</span>;
  if (typeof value === 'boolean') return <span>{value ? 'yes' : 'no'}</span>;
  if (typeof value === 'number' || typeof value === 'string') return <span>{String(value)}</span>;
  return <code>{JSON.stringify(value)}</code>;
}

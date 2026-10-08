/**
 * The console's pages by path (B088): `/`, `/users/:id`, `/workspaces/:id`, `/sessions/:id`,
 * `/flags`, `/incidents`, `/staff-audit`. Ids in paths are CT-IDS ids only; no token, e-mail
 * address or search ever goes into a URL.
 */
import { isId } from './api/token.js';

/** A page. */
export type Route =
  | { page: 'lookup' }
  | { page: 'user'; id: string }
  | { page: 'workspace'; id: string }
  | { page: 'session'; id: string }
  | { page: 'flags' }
  | { page: 'incidents' }
  | { page: 'staff-audit' }
  | { page: 'not-found' };

const DETAIL: Record<string, { page: 'user' | 'workspace' | 'session'; prefix: string }> = {
  users: { page: 'user', prefix: 'usr' },
  workspaces: { page: 'workspace', prefix: 'wsp' },
  sessions: { page: 'session', prefix: 'ses' },
};

/** The page at `pathname`. */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter((p) => p !== '');
  if (parts.length === 0) return { page: 'lookup' };
  if (parts.length === 1) {
    if (parts[0] === 'flags') return { page: 'flags' };
    if (parts[0] === 'incidents') return { page: 'incidents' };
    if (parts[0] === 'staff-audit') return { page: 'staff-audit' };
  }
  if (parts.length === 2) {
    const detail = DETAIL[parts[0] ?? ''];
    const id = parts[1];
    if (detail !== undefined && isId(detail.prefix, id)) return { page: detail.page, id };
  }
  return { page: 'not-found' };
}

/** The path of an entity page for `id` (`usr_`, `wsp_`, `ses_`), or null for any other value. */
export function pathOfId(id: unknown): string | null {
  if (isId('usr', id)) return `/users/${id}`;
  if (isId('wsp', id)) return `/workspaces/${id}`;
  if (isId('ses', id)) return `/sessions/${id}`;
  return null;
}

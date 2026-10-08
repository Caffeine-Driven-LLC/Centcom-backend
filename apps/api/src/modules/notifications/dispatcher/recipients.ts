/**
 * Who a notification event reaches (B063), resolved when it is dispatched:
 *
 * - `{users}`: those who are active; when the params name a session, only those still in it;
 * - `{workspace, roles}`: the active members of the live workspace with one of the roles (a member
 *   who left has no membership any more);
 * - `{session, members}`: the active users behind those session members who have not left.
 *
 * Nobody outside the related workspace or session is notified. Each user once, in id order.
 *
 * Owns: the recipient rules.
 */
import type { NotificationEvent } from '@centcom/core';
import type { NotificationStore } from '@centcom/db';

/** The lookups recipients are resolved with (the notification store). */
export type RecipientDirectory = Pick<
  NotificationStore,
  'workspaceMembers' | 'sessionMemberUsers' | 'sessionUsersAmong' | 'activeUsers'
>;

/** The users `event` reaches. */
export async function resolveRecipients(
  event: NotificationEvent,
  directory: RecipientDirectory,
): Promise<string[]> {
  const r = event.recipients;
  let users: string[];
  if ('users' in r) {
    users = await directory.activeUsers([...new Set(r.users)]);
    const session = event.params['session'];
    if (typeof session === 'string') users = await directory.sessionUsersAmong(session, users);
  } else if ('workspace' in r) {
    users = await directory.workspaceMembers(r.workspace, [...new Set(r.roles)]);
  } else {
    users = await directory.sessionMemberUsers(r.session, [...new Set(r.members)]);
  }
  return [...new Set(users)].sort();
}

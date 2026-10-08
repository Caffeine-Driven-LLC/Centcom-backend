/**
 * Notification links (B033, CT-NOTIF-PAYLOAD): the `action.deeplink` of an `open_session`
 * notification is the app link of CT-DEEPLINK's open-a-session row,
 * `centcom://session/<ses_id>[?focus=approval|queue]`.
 *
 * Owns: that one link. Must not: put anything but the session id and the focus in it.
 */
import { buildSessionUrl, type SessionFocus } from '@centcom/core';

/** The `action.deeplink` that opens a session, at its approvals or its queue when asked. */
export function notificationDeeplink(sessionId: string, focus?: SessionFocus): string {
  return buildSessionUrl(sessionId, focus).app;
}

/**
 * Invite links (B033): B029's `InviteUrlBuilder` port, built on CT-DEEPLINK's workspace-invite
 * row. `inviteUrl` is the web link the create response and the invite e-mail carry
 * (`<WEB_BASE_URL>/i/<token>`); `joinUrl` the app link that opens the invite in a client
 * (`centcom://invite/<token>`).
 *
 * Owns: the port's implementation. Must not: add a fragment or log a token.
 */
import { buildInviteUrl, DEFAULT_WEB_BASE_URL } from '@centcom/core';
import type { InviteUrlBuilder } from '../invites/index.js';

/** The invite links on `webBase` (default `https://centcom.dev`). */
export function createInviteUrlBuilder(webBase: string = DEFAULT_WEB_BASE_URL): InviteUrlBuilder {
  return {
    inviteUrl: (token) => buildInviteUrl(token, webBase).web,
    joinUrl: (token) => buildInviteUrl(token, webBase).app,
  };
}

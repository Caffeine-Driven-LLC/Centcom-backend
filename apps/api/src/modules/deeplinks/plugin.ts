/**
 * Deep links on the API (B033): the plugin puts B029's `InviteUrlBuilder` (`app.inviteUrls`) and
 * the notification link builder (`app.notificationDeeplink`) on the instance, both on the
 * configured web origin (WEB_BASE_URL, read at registration, so a bad value fails the boot).
 *
 *   await app.register(deeplinksPlugin); // or { config: deeplinkConfig(env) }
 *   const invites = new InviteService({ urls: app.inviteUrls, ... });
 *
 * Owns: the decorations. Must not: build a link itself (`@centcom/core` does).
 */
import { deeplinkConfig, type DeeplinkConfig, type SessionFocus } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { InviteUrlBuilder } from '../invites/index.js';
import { createInviteUrlBuilder } from './invite-urls.js';
import { notificationDeeplink } from './notifications.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** B029's invite links (B033). */
    inviteUrls: InviteUrlBuilder;
    /** The `action.deeplink` of an `open_session` notification (B033). */
    notificationDeeplink: (sessionId: string, focus?: SessionFocus) => string;
  }
}

/** Options for `deeplinksPlugin`. */
export interface DeeplinksPluginOptions {
  /** Default: `deeplinkConfig()`, from the process environment. */
  config?: DeeplinkConfig;
}

const plugin: FastifyPluginAsync<DeeplinksPluginOptions> = async (app, opts) => {
  const config = opts.config ?? deeplinkConfig();
  app.decorate('inviteUrls', createInviteUrlBuilder(config.webBase));
  app.decorate('notificationDeeplink', notificationDeeplink);
};

/** Registers the link builders on the whole instance; register it before the invite routes. */
export const deeplinksPlugin: FastifyPluginAsync<DeeplinksPluginOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-deeplinks',
});

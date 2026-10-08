/**
 * Deep links on the API (B033): the Fastify plugin, B029's invite link builder and the
 * notification link builder. The links themselves are built in `@centcom/core`
 * (`packages/core/src/deeplink/`).
 */
export { createInviteUrlBuilder } from './invite-urls.js';
export { notificationDeeplink } from './notifications.js';
export { deeplinksPlugin, type DeeplinksPluginOptions } from './plugin.js';

/**
 * Deep links and join URLs (B033, CT-DEEPLINK): building and reading every link in the contract's
 * table, link tokens and their lifetimes, and the fragment guard. The Fastify plugin that puts the
 * builders on the API lives in `apps/api/src/modules/deeplinks/`. See README.md in this package.
 */
export { deeplinkConfig, deeplinkEnvSchema, type DeeplinkConfig } from './config.js';
export { assertServerUrl, withKeyFragment } from './fragment.js';
export {
  MAX_DEEP_LINK_LENGTH,
  parseDeepLink,
  type DeepLink,
  type DeepLinkForm,
  type DeepLinkKind,
  type NotADeepLink,
  type ParseDeepLinkOptions,
} from './parse.js';
export {
  cryptoRandomSource,
  generateLinkToken,
  LINK_TOKEN_BYTES,
  LINK_TTL,
  type RandomSource,
} from './token.js';
export {
  APP_SCHEME,
  AUTH_PARAM_PATTERN,
  buildAuthCallbackUrl,
  buildBillingUrl,
  buildInviteUrl,
  buildJoinUrl,
  buildSessionUrl,
  buildShareUrl,
  DEFAULT_WEB_BASE_URL,
  isLinkToken,
  isSessionFocus,
  LINK_TOKEN_PATTERN,
  SESSION_FOCUSES,
  webOrigin,
  type LinkPair,
  type SessionFocus,
} from './urls.js';

/**
 * Social login module (B015): GitHub and Google sign-in with verified-e-mail account matching.
 * HTTP: `routes/login-social.ts`. The `return_to` allow-list is `modules/auth/return-to.ts`.
 */
export {
  callbackUrl,
  loadSocialConfig,
  socialEnvSchema,
  type ProviderClient,
  type SocialConfig,
} from './config.js';
export { GITHUB, githubAuthorizeUrl, githubIdentity, primaryVerifiedEmail } from './github.js';
export {
  GOOGLE,
  GOOGLE_JWKS_MAX_AGE_MS,
  GOOGLE_JWKS_REFETCH_MS,
  googleAuthorizeUrl,
  googleIdentity,
  GoogleKeys,
  ID_TOKEN_SKEW_S,
  verifyGoogleIdToken,
  type GoogleIdClaims,
} from './google.js';
export { createIdentityRepo, isIdentityTaken, type IdentityRepo } from './identities.js';
export {
  clearStateCookieHeader,
  newOAuthState,
  openState,
  pkceChallenge,
  readCookie,
  sameState,
  sealState,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  STATE_TTL_MS,
  stateCookieHeader,
  type OAuthState,
} from './oauth-state.js';
export {
  PROVIDER_TIMEOUT_MS,
  requestJson,
  SocialLoginError,
  type Fetch,
  type ProviderCall,
  type ProviderIdentity,
  type SocialLoginFailure,
} from './provider.js';
export {
  isProvider,
  PROVIDERS,
  SocialLoginService,
  type SocialLoginDeps,
  type UserSignIn,
} from './service.js';

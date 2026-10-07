/**
 * Social login configuration (B015): each provider's OAuth client, the base URL its callbacks
 * live under, the key that signs the OAuth state cookie, and the `return_to` allow-list (shared
 * with B014). A provider whose client id or secret is missing is turned off: its routes answer
 * 404, it is left out of login pages, and a warning says so at startup.
 *
 * Owns: reading and checking these keys. Must not: put a secret in a warning or error.
 */
import { defineConfig, envUrl, secretString, z, type Env, type Secret } from '@centcom/core';
import type { IdentityProvider } from '@centcom/db';
import { returnToAllowlistSchema, returnToPolicy, type ReturnToPolicy } from '../return-to.js';

/** The environment keys of social login. */
export const socialEnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().optional().meta({
    description: 'GitHub OAuth app client id; without it (or the secret) GitHub sign-in is off.',
    example: 'Iv1.0123456789abcdef',
  }),
  GITHUB_CLIENT_SECRET: secretString()
    .optional()
    .meta({ description: 'GitHub OAuth app client secret.', example: 'github-client-secret' }),
  GOOGLE_CLIENT_ID: z.string().optional().meta({
    description: 'Google OAuth client id; without it (or the secret) Google sign-in is off.',
    example: '1234.apps.googleusercontent.com',
  }),
  GOOGLE_CLIENT_SECRET: secretString()
    .optional()
    .meta({ description: 'Google OAuth client secret.', example: 'google-client-secret' }),
  SOCIAL_REDIRECT_BASE_URL: envUrl({ protocols: ['https:', 'http:'], plain: true }).meta({
    description:
      'Public base URL of the API; provider callbacks are <base>/login/<provider>/callback.',
    example: 'http://localhost:3000',
  }),
  SOCIAL_STATE_SECRET: secretString(z.string().min(32)).meta({
    description:
      'Key (at least 32 characters) that signs the OAuth state cookie; the same on every instance.',
    example: 'change-me-to-32-or-more-random-characters',
  }),
  LOGIN_RETURN_TO_ALLOWLIST: returnToAllowlistSchema.meta({
    description:
      'Comma-separated URLs a login may return to (exact match); the first is the default.',
    example: 'http://localhost:5173/',
  }),
});

/** One provider's OAuth client. */
export interface ProviderClient {
  clientId: string;
  clientSecret: Secret;
}

/** Checked social login settings. */
export interface SocialConfig {
  /** The providers that are on. */
  providers: Partial<Record<IdentityProvider, ProviderClient>>;
  /** Without a trailing slash. */
  redirectBaseUrl: string;
  stateSecret: Secret;
  returnTo: ReturnToPolicy;
}

/** The callback URL a provider sends users back to. */
export const callbackUrl = (
  config: Pick<SocialConfig, 'redirectBaseUrl'>,
  provider: IdentityProvider,
): string => `${config.redirectBaseUrl}/login/${provider}/callback`;

/**
 * Reads the settings (default: the process environment, through the config loader). A provider
 * missing its id or secret is off, reported through `onWarning` (for the startup log).
 */
export function loadSocialConfig(
  env?: Env,
  onWarning: (message: string) => void = () => undefined,
): SocialConfig {
  const values = defineConfig(socialEnvSchema, env);
  const providers: SocialConfig['providers'] = {};
  const clients = [
    ['github', values.GITHUB_CLIENT_ID, values.GITHUB_CLIENT_SECRET],
    ['google', values.GOOGLE_CLIENT_ID, values.GOOGLE_CLIENT_SECRET],
  ] as const;
  for (const [provider, clientId, clientSecret] of clients) {
    if (clientId !== undefined && clientSecret !== undefined)
      providers[provider] = { clientId, clientSecret };
    else onWarning(`social login: ${provider} is off (its client id or secret is not configured)`);
  }
  return {
    providers,
    redirectBaseUrl: values.SOCIAL_REDIRECT_BASE_URL.replace(/\/+$/, ''),
    stateSecret: values.SOCIAL_STATE_SECRET,
    returnTo: returnToPolicy(values.LOGIN_RETURN_TO_ALLOWLIST),
  };
}

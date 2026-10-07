/**
 * GitHub sign-in (B015): the authorize URL (scopes `read:user user:email`, `state`, PKCE S256),
 * the code exchange, and the identity: the account's numeric id from `GET /user` and its primary
 * address from `GET /user/emails`, used only when GitHub marks it verified. The access token is
 * used for those two calls and dropped.
 *
 * Owns: talking to GitHub. Must not: keep or log GitHub's token or the code, or use an e-mail
 * address GitHub has not verified.
 */
import type { ProviderClient } from './config.js';
import {
  formBody,
  requestJson,
  SocialLoginError,
  type ProviderCall,
  type ProviderIdentity,
} from './provider.js';

/** GitHub's endpoints. */
export const GITHUB = Object.freeze({
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  api: 'https://api.github.com',
  scope: 'read:user user:email',
});

/** Where to send the browser. */
export function githubAuthorizeUrl(
  client: ProviderClient,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(GITHUB.authorize);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: GITHUB.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'true',
  }).toString();
  return url.toString();
}

/** The address to sign in with: the primary one, when verified; undefined otherwise. */
export function primaryVerifiedEmail(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  for (const entry of emails as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { email, primary, verified } = entry as Record<string, unknown>;
    if (primary === true && verified === true && typeof email === 'string' && email !== '')
      return email;
  }
  return undefined;
}

/** Exchanges the code and reads who signed in. */
export async function githubIdentity(
  call: ProviderCall,
  client: ProviderClient,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<ProviderIdentity> {
  const token = await requestJson(call, 'github', GITHUB.token, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: client.clientId,
      client_secret: client.clientSecret.reveal(),
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  // GitHub answers a refused exchange with 200 and an `error` field.
  const accessToken = Array.isArray(token) ? undefined : token['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '')
    throw new SocialLoginError('denied', 'github');

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'centcom-api',
    'x-github-api-version': '2022-11-28',
  };
  const user = await requestJson(call, 'github', `${GITHUB.api}/user`, { headers });
  const id = Array.isArray(user) ? undefined : user['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw new SocialLoginError('invalid_identity', 'github');
  const emails = await requestJson(call, 'github', `${GITHUB.api}/user/emails`, { headers });
  const email = primaryVerifiedEmail(emails);
  if (email === undefined) throw new SocialLoginError('no_verified_email', 'github');

  const { name, login } = user as Record<string, unknown>;
  const display = typeof name === 'string' && name.trim() !== '' ? name : login;
  return {
    provider: 'github',
    subject: String(id),
    email,
    ...(typeof display === 'string' ? { name: display } : {}),
  };
}

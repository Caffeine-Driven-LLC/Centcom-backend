/**
 * Social login (B015): `begin` sends the browser to GitHub or Google with a fresh state, PKCE
 * challenge and (Google) nonce kept in a signed cookie; `complete` checks the callback against
 * that cookie, exchanges the code, verifies the identity and finds the user:
 *
 * 1. an account seen before signs in as the user it was linked to (whatever its e-mail now);
 * 2. otherwise its verified e-mail is the user's (B013 `getOrCreateByEmail` returns the user who
 *    has it, or creates one) and the account is linked to that user.
 *
 * Concurrent first logins of one account end with one user (B013) and one identity (the
 * identities primary key; the loser reads the winner's link). Provider tokens and codes are
 * used in memory and dropped.
 *
 * Owns: the login decision. Must not: link on an unverified e-mail, skip the state or PKCE
 * check, or keep anything from the provider but the account id.
 */
import { isConnectionError, type IdentityProvider } from '@centcom/db';
import type { SignInResult } from '../../users/service.js';
import { callbackUrl, type SocialConfig } from './config.js';
import { githubAuthorizeUrl, githubIdentity } from './github.js';
import { GoogleKeys, googleAuthorizeUrl, googleIdentity } from './google.js';
import type { IdentityRepo } from './identities.js';
import { newOAuthState, openState, pkceChallenge, sameState, sealState } from './oauth-state.js';
import {
  PROVIDER_TIMEOUT_MS,
  SocialLoginError,
  type Fetch,
  type ProviderCall,
  type ProviderIdentity,
} from './provider.js';

/** The providers there are. */
export const PROVIDERS: readonly IdentityProvider[] = ['github', 'google'];

/** True for a provider name. */
export const isProvider = (value: unknown): value is IdentityProvider =>
  value === 'github' || value === 'google';

/** What the login needs from the users module (B013). */
export interface UserSignIn {
  getOrCreateByEmail(email: string, hints?: { name?: string }): Promise<SignInResult>;
}

/** Dependencies of the service. */
export interface SocialLoginDeps {
  config: SocialConfig;
  users: UserSignIn;
  identities: IdentityRepo;
  /** Default the global `fetch`; tests inject a fake provider. */
  fetch?: Fetch;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
  /** Per provider call; default 5 s. */
  timeoutMs?: number;
}

/** Social login with GitHub and Google. */
export class SocialLoginService {
  private readonly config: SocialConfig;
  private readonly users: UserSignIn;
  private readonly identities: IdentityRepo;
  private readonly now: () => number;
  private readonly call: ProviderCall;
  private readonly googleKeys: GoogleKeys;

  constructor(deps: SocialLoginDeps) {
    this.config = deps.config;
    this.users = deps.users;
    this.identities = deps.identities;
    this.now = deps.now ?? Date.now;
    this.call = {
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: deps.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    };
    this.googleKeys = new GoogleKeys(this.call, this.now);
  }

  /** True when the provider is configured. */
  enabled(provider: IdentityProvider): boolean {
    return this.config.providers[provider] !== undefined;
  }

  /** The providers that are configured, for login pages. */
  enabledProviders(): IdentityProvider[] {
    return PROVIDERS.filter((provider) => this.enabled(provider));
  }

  /**
   * Starts a login: the provider's authorize URL and the sealed state for the cookie. `returnTo`
   * is resolved against the allow-list (anything else becomes the default).
   */
  begin(
    provider: IdentityProvider,
    returnTo: unknown,
  ): Promise<{ redirect: string; stateCookie: string; returnTo: string }> {
    const client = this.config.providers[provider];
    if (client === undefined) return Promise.reject(new SocialLoginError('denied', provider));
    const target = this.config.returnTo.resolve(returnTo);
    const state = newOAuthState(provider, target, this.now());
    const challenge = pkceChallenge(state.verifier);
    const redirectUri = callbackUrl(this.config, provider);
    const redirect =
      provider === 'github'
        ? githubAuthorizeUrl(client, redirectUri, state.state, challenge)
        : googleAuthorizeUrl(client, redirectUri, state.state, challenge, state.nonce ?? '');
    return Promise.resolve({
      redirect,
      stateCookie: sealState(state, this.config.stateSecret),
      returnTo: target,
    });
  }

  /**
   * Finishes a login from the provider's callback. Throws a SocialLoginError (`state`, `denied`,
   * `provider`, `no_verified_email`, `invalid_identity`) before any account change when anything
   * does not check out.
   */
  async complete(
    provider: IdentityProvider,
    query: { code?: unknown; state?: unknown; error?: unknown },
    stateCookie: string | undefined,
  ): Promise<{ userId: string; returnTo: string; created: boolean }> {
    const client = this.config.providers[provider];
    if (client === undefined) throw new SocialLoginError('denied', provider);
    const state = openState(stateCookie, this.config.stateSecret, this.now());
    if (
      state === undefined ||
      state.provider !== provider ||
      typeof query.state !== 'string' ||
      !sameState(query.state, state.state)
    ) {
      throw new SocialLoginError('state', provider);
    }
    // The user declined at the provider (RFC 6749 §4.1.2.1), after the state proved the callback ours.
    if (query.error !== undefined) throw new SocialLoginError('denied', provider);
    if (typeof query.code !== 'string' || query.code === '' || query.code.length > 2048) {
      throw new SocialLoginError('denied', provider);
    }
    const redirectUri = callbackUrl(this.config, provider);
    const identity =
      provider === 'github'
        ? await githubIdentity(this.call, client, redirectUri, query.code, state.verifier)
        : await googleIdentity(
            this.call,
            client,
            redirectUri,
            query.code,
            state.verifier,
            state.nonce ?? '',
            this.googleKeys,
            this.now(),
          );
    const { userId, created } = await this.signIn(identity);
    return { userId, returnTo: state.returnTo, created };
  }

  /** The user an identity signs in as: its link, else its verified e-mail's user (linked now). */
  private async signIn(identity: ProviderIdentity): Promise<{ userId: string; created: boolean }> {
    try {
      const linked = await this.identities.findUserId(identity.provider, identity.subject);
      if (linked !== null) return { userId: linked, created: false };
      const { user, created } = await this.users.getOrCreateByEmail(
        identity.email,
        identity.name === undefined ? {} : { name: identity.name },
      );
      if (await this.identities.link(identity.provider, identity.subject, user.id))
        return { userId: user.id, created };
      // Linked concurrently by another login of this account: that link wins.
      const winner = await this.identities.findUserId(identity.provider, identity.subject);
      if (winner === null) throw new SocialLoginError('provider', identity.provider);
      return { userId: winner, created: false };
    } catch (err) {
      if (err instanceof SocialLoginError) throw err;
      // A provider address our rules refuse (shape, length) cannot sign in.
      if ((err as { code?: unknown } | null)?.code === 'validation_failed') {
        throw new SocialLoginError('no_verified_email', identity.provider, { cause: err });
      }
      if (isConnectionError(err))
        throw new SocialLoginError('provider', identity.provider, { cause: err });
      throw err;
    }
  }
}

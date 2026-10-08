/**
 * Where Stripe sends a customer back (B071, CT-DEEPLINK "Upgrade / billing"): always the web
 * billing page of the configured origin (WEB_BASE_URL, default `https://centcom.dev/billing`),
 * never a URL from the request. Stripe redirects only to web URLs; the page hands the user on to
 * the app (`centcom://billing`, `appRedirect`). A query parameter tells the page what happened:
 * `checkout=success` or `checkout=cancel` (CT-DEEPLINK: unknown parameters are ignored), and none
 * for the portal's return.
 *
 * Owns: the redirect URLs. Must not: read anything from a request.
 */
import { buildBillingUrl, deeplinkConfig } from '@centcom/core';

/** The redirects billing hands to Stripe. */
export type RedirectKind = 'checkout_success' | 'checkout_cancel' | 'portal_return';

/** The query each redirect carries, if any. */
export const REDIRECT_QUERY: Readonly<Record<RedirectKind, string | null>> = Object.freeze({
  checkout_success: 'checkout=success',
  checkout_cancel: 'checkout=cancel',
  portal_return: null,
});

const withQuery = (url: string, kind: RedirectKind): string => {
  const query = REDIRECT_QUERY[kind];
  return query === null ? url : `${url}?${query}`;
};

/**
 * The web URL Stripe sends the customer to after `kind`, on `webBase` (default the configured
 * WEB_BASE_URL): `https://centcom.dev/billing?checkout=success` and so on.
 */
export function buildRedirects(
  kind: RedirectKind,
  webBase: string = deeplinkConfig().webBase,
): string {
  return withQuery(buildBillingUrl(webBase).web, kind);
}

/** The app's deep link for `kind`, which the web page opens: `centcom://billing?…`. */
export function appRedirect(kind: RedirectKind): string {
  return withQuery(buildBillingUrl().app, kind);
}

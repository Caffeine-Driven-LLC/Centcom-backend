/**
 * The pages of e-mail sign-in (B014): plain HTML, no scripts or styles, every value escaped.
 *
 * - **Sent:** the same page for every address, so it cannot tell whether an account exists.
 * - **Confirm:** a GET of the link only shows a button that POSTs it back with a CSRF token, so a
 *   mail scanner fetching the link uses nothing up.
 * - **Other browser:** the link was opened somewhere without the requesting browser's cookie.
 * - **Failed:** one page for every way a link can fail.
 *
 * Owns: the copy and markup. Must not: say why a link failed, or include anything that differs
 * by account.
 */
import { escapeHtml } from '@centcom/core';

/** A whole page with `title` and `body` (already escaped HTML). */
const page = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;

/** After a request: the same for every address. */
export const sentPage = (): string =>
  page(
    'Check your email',
    '<p>If the address can receive email, a sign-in link is on its way. It works once, for a short time, in this browser.</p>',
  );

/** The link opened: a button that signs in with a POST. */
export const confirmPage = (token: string, csrf: string): string =>
  page(
    'Sign in to Centcom',
    `<form method="post" action="/login/email/verify">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit">Sign in</button>
</form>`,
  );

/** The link opened in a browser that did not ask for it. */
export const otherBrowserPage = (): string =>
  page(
    'Open the link in the same browser',
    '<p>This sign-in link works only in the browser where you asked for it. Open it there, or ask for a new link in this browser.</p>',
  );

/** Any link that cannot sign in. */
export const failedPage = (): string =>
  page(
    'This sign-in link does not work',
    '<p>The link is invalid, already used or expired. Ask for a new one.</p>',
  );

/** An address that is not one. */
export const invalidEmailPage = (): string =>
  page('Enter a valid email address', '<p>Go back and check the address, then try again.</p>');

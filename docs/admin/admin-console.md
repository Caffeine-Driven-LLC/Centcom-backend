# Internal admin console

Lane B088. A small web console over the [internal admin API](admin-api.md) (B087) for Centcom staff
doing support: look up accounts, workspaces and sessions (metadata only), inspect entitlements and
usage, revoke access, and manage feature flags and status incidents. It never shows or asks for
session content, history, keys or message text, and it cannot act as a user.

## Running it

| Command                                     | What it does                                                        |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm --filter @centcom/admin dev`          | Dev server on `http://127.0.0.1:5173`                               |
| `pnpm --filter @centcom/admin build:assets` | Static build into `apps/admin/dist/web/` (also run by `pnpm build`) |

| Variable              | Meaning                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `VITE_ADMIN_API_BASE` | The admin API's origin, such as `https://admin.internal`. Empty: the console's own origin. Read at build time. |

The build is a static site: `index.html` and hashed files under `assets/`. It loads nothing from any
other origin (no CDN, fonts, analytics or third-party scripts), and calls only the admin API.

## Deploying

- **Private network only.** Never put the console on a public hostname or behind the public load
  balancer. Serve `dist/web/` from a host reachable only inside the private network, like the admin
  listener itself (`ADMIN_ALLOWED_CIDRS`).
- **One origin with the API.** The admin listener sends no CORS headers, so serve the console and
  `/internal/admin/v1` from the same origin: a private reverse proxy that sends
  `/internal/admin/v1/*` to the admin listener and everything else to `dist/web/` (with
  `index.html` for unknown paths, so `/users/usr_…` loads the app). Build with
  `VITE_ADMIN_API_BASE` empty in that case.
- **Headers.** `index.html` carries its CSP in a `<meta>` tag:

  ```
  default-src 'self'; script-src 'self'; connect-src 'self' <admin api origin>; frame-ancestors 'none'
  ```

  Browsers ignore `frame-ancestors` in a `<meta>` tag, so the server should also send that CSP as a
  header, with `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store` for `index.html` (the hashed assets may be cached).

## Signing in

1. Get a staff access token: a user access token with the `admin` scope, from the staff token flow
   (for example the CLI's device sign-in asking for `admin`). Your user must have an enabled
   `staff_users` row.
2. Paste it on the sign-in page. The console keeps it in the tab's memory only: never in
   `localStorage`, `sessionStorage`, cookies, URLs or console output. Reloading the tab signs you
   out.
3. Give a reason (10 to 500 characters) and, if you have one, a ticket. Every call to the admin API
   carries them (`X-Admin-Reason`, `X-Admin-Ticket`) and the admin API audits each call with them.
   Cancelling the reason dialog sends nothing. **Change reason** in the header starts a new task.
4. The console asks the admin API for your own record; your role comes from that answer, not from
   the token.

You are signed out after 15 minutes without activity (keyboard, pointer, wheel or touch), when the
admin API stops accepting the token (`401`), and when your account is no longer staff. A `403`
makes the console ask for your role again: if it went down, write controls disappear.

## Pages

| Path              | Shows                                                                              | Writes (support_rw and up)                          |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `/`               | Look up by `usr_`, `wsp_` or `ses_` id, or a user by e-mail address                |                                                     |
| `/users/:id`      | The user, devices (no keys), workspaces                                            | Revoke all tokens, revoke a device, disable sign-in |
| `/workspaces/:id` | Members and roles, plan, subscription status, entitlements, usage                  | Grant a promotion                                   |
| `/sessions/:id`   | State, region, times, member count, host member (never the name or content)        | End the session                                     |
| `/flags`          | Set or delete a flag by key (a B083 definition as JSON)                            | Set, delete                                         |
| `/incidents`      | Open an incident, add an update                                                    | Open, update                                        |
| `/staff-audit`    | Admin API calls, newest first, with reasons and tickets; filter by actor or target |                                                     |

- `support_ro` sees e-mail addresses masked (the admin API masks them) and no write control.
- Revoking tokens, disabling sign-in and ending a session ask you to type the exact target id; the
  button stays disabled until you do.
- A failed call shows the admin API's problem (title, detail) and its request id, to quote to
  whoever reads the logs. Nothing is retried on its own, writes least of all.
- An e-mail address searched for stays in the page: it never goes into the console's URL.

## Security properties

- Everything the API returns is rendered as text. There is no `dangerouslySetInnerHTML`, `innerHTML`
  or `document.write` in the console, and ESLint refuses them in `apps/admin/src` (with `eval` and
  browser storage).
- Requests go only to `VITE_ADMIN_API_BASE` (or the console's own origin), without cookies or a
  referrer, never cached, never following redirects.

## Gaps in the admin API

Filed against B087 (this lane adds no backend endpoint):

- no list of flags or incidents, so the editors work by key and id;
- no CORS on the admin listener (hence the one-origin deployment above);
- invite resend and staff management have no page yet (the routes exist).

## Tests

`apps/admin/test/`:

- `client.test.ts`: what each call carries, problem+json mapping, network failures, the 401 and 403
  hooks, no retries; the reason, token and route helpers.
- `console.test.tsx`: every page and write against a fake admin API (typed by B087's bodies, seeing
  every request as the global `fetch`): the reason on every request, cancel sends nothing,
  `support_ro` never writes, typed-id confirmation, the token never stored or logged, the 15-minute
  sign-out (fake timers), XSS rendering, 401, 403 and 5xx handling, the smoke run (sign in, look up,
  workspace, set a flag), and accessibility basics.
- `build.test.ts`: a real `vite build`: the CSP, no third-party origins, no source maps or inline
  code, the initial bundle within 250 KiB gzipped, and the lint rules.

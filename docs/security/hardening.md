# Security hardening (B097)

What protects the API's surface and the supply chain, where it lives, and what is still open.

## Response headers and CORS

`apps/api/src/plugins/security-headers.ts`, registered first in `buildApp`, so it also answers CORS
preflights before the rate limiter counts them.

| Header                         | Value                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security`    | `max-age=31536000; includeSubDomains; preload`                                                                   |
| `Content-Security-Policy`      | `default-src 'none'; frame-ancestors 'none'`                                                                     |
| `X-Content-Type-Options`       | `nosniff`                                                                                                        |
| `Referrer-Policy`              | `no-referrer`                                                                                                    |
| `Cross-Origin-Resource-Policy` | `same-site`                                                                                                      |
| `Permissions-Policy`           | every feature switched off (`camera=(), microphone=(), geolocation=(), ...`)                                     |
| `Cache-Control`                | `no-store` forced on `/v1/auth/*` and the billing routes; the default for any other `/v1/*` reply that sets none |

Every reply gets them: 2xx, 304, 4xx, 5xx and preflights (a table-driven test covers 18 cases).

**CORS.** Only the origins in `WEB_ALLOWED_ORIGINS` (the same list the token endpoint already
checks; the card calls it `CORS_ALLOWED_ORIGINS`, a second key for the same list would only drift)
get `Access-Control-Allow-Origin`, as the exact origin and with `Vary: Origin`. No wildcard, no
reflection of other origins, `null` is not an origin. `Access-Control-Allow-Credentials: true` is
sent only on `/v1/auth/token` (the web client's refresh cookie; the route itself still requires
`X-Centcom-Client: web`). Preflights are answered with 204 and `Access-Control-Max-Age: 600`.

### Exception list

A route may set a header itself; the plugin keeps it. The only deviation from the table above:

| Route     | Header                    | Value                                                                                       | Why                                                |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `/device` | `Content-Security-Policy` | `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'` | the HTML approval page has inline style and a form |

`apps/api/test/security-headers.test.ts` pins this list: any other route differing from the base
headers fails the test, so adding an exception means editing this table and that test.

## Edge rules (WAF)

`infra/terraform/modules/waf/` (Cloudflare): the managed ruleset, per-address rate limits (auth
endpoints 20 a minute, requests without credentials 30), HTTPS only, TRACE/TRACK/CONNECT refused,
and the relay hosts limited to the WebSocket path. Every ruleset starts by skipping `/healthz`,
`/readyz` and `/v1/status`. See the module's README for plan limits.

**Runbook: a rule blocks legitimate traffic.** Set `mode = "log"` (Enterprise) or `"off"` in the
module call and `terraform apply`. No application deploy. Find the rule from the Cloudflare
security events (`rule_ids` output), fix the expression, set the mode back.

The body-size limits of the card (1 MiB on `/v1/usage/events`, 256 KiB elsewhere) are enforced by
the API itself (`bodyLimit`, 256 KiB default); a Cloudflare rule on body size needs a higher plan.

## Secret scanning

- `pnpm security:secrets`: AWS keys, Centcom API keys (`cen_live_`/`cen_test_` + 32 base62), PEM
  private keys, GitHub, Slack and Stripe tokens, over the tracked files. Prints `path:line rule`.
  Reviewed false positives are in `infra/security/secrets-allowlist.json` (rule + path prefix,
  reason, expiry; an expired or reason-less entry makes the scan fail with exit 2).
- `.gitleaks.toml`: the same custom rules on top of gitleaks' defaults; CI already runs gitleaks
  over the history of each pull request (`.github/workflows/security.yml`). Accepted findings are
  in `.gitleaksignore` or an allowlist with an `expires:` date in its description (a test fails
  after it).
- Pre-commit: `pnpm security:install-hook` once per clone.
- Provider credentials inside logs, requests, frames, telemetry and backups: lane B101.

## Dependency policy

`pnpm security:deps` (run it with `--mode warn` on pull requests):

1. **Install scripts.** No installed package may declare `preinstall`, `install` or `postinstall`
   (or ship a `binding.gyp`) unless it is on `infra/security/install-script-allowlist.json`. Scripts
   are never run (`ignoreScripts` in `pnpm-workspace.yaml`), but a package that wants one is worth
   knowing about. <a id="install-scripts"></a>Allowed today, each with a reason and a review date:
   `esbuild`, `cpu-features`, `ssh2` (development tooling only, not in any image), `msgpackr-extract`
   (via bullmq; falls back to JavaScript) and `protobufjs` (via OpenTelemetry).
2. **Exact pins.** No `^`, `~` or range in any `package.json` (also part of `pnpm lint`).
3. **Licences.** MIT, Apache-2.0, BSD-2/3, ISC or 0BSD for production dependencies; a package
   with no licence metadata fails until reviewed; reviewed exceptions in
   `infra/security/license-allowlist.json`. (`pnpm security:licenses` runs this part alone.)
4. **Advisories.** `pnpm audit --prod --audit-level high`, retried once. If the advisory service is
   down it fails closed on `main` and warns on pull requests.

`pnpm security:sbom` writes a CycloneDX SBOM per service to `sbom/` (from the lockfile, production
dependencies). An SBOM of a built image (with the base image's packages) is `trivy image --format
cyclonedx`.

## Containers

The production images (`infra/deploy/Dockerfile`, lane B091) run as the unprivileged `node` user,
under tini, from a slim Node image, with `no-new-privileges`, all capabilities dropped and a
read-only root filesystem for api, worker and relay; a test in `infra/deploy/deploy.test.ts` fails
if a runtime target loses its `USER`.

## Not done here (needs a human or an account)

- **Workflows** (`.github/` is protected): `security-scan.yml` (gitleaks on the diff, weekly full
  history; the existing `security.yml` already scans PR history and runs the audit and licence
  check), a Dependabot/Renovate config with grouped weekly updates, trivy (fail on critical) and
  hadolint on the images, attaching `sbom/` to the run. Suggested steps: `pnpm security:deps
--mode warn` on pull requests, `pnpm security:deps` on main, `pnpm security:sbom` and
  `actions/upload-artifact`.
- **Applying the WAF module** needs a Cloudflare API token; it has been validated and planned
  offline, never applied.

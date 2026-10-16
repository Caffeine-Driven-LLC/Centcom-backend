# Fly secrets (names only)

Values are never committed. Set each one per app with `fly secrets set NAME=... -a centcom-<env>-<app>`
from the secret manager at deploy time. A test (`infra/terraform/envs.test.ts`) fails when a
`fly.*.toml` file names a secret that is not listed here.

| Secret                           | Apps                          | What it is                                                                  |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                   | api, relay, worker, admin     | `postgres://` URL of `centcom-<env>-db.flycast`, with the operator password |
| `REDIS_URL`                      | api, relay, worker            | `redis://:<password>@centcom-<env>-redis.flycast:6379`                      |
| `AUTH_SIGNING_KEYS`              | api                           | JWT signing keys (JSON, current and previous)                               |
| `IDEMPOTENCY_ENCRYPTION_KEY`     | api                           | Key that encrypts stored idempotent responses                               |
| `CURSOR_SIGNING_KEYS`            | api                           | Keys that sign pagination cursors                                           |
| `OBJECT_STORE_ACCESS_KEY_ID`     | api, worker                   | R2 API token id for the environment's buckets                               |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | api, worker                   | R2 API token secret                                                         |
| `STRIPE_SECRET_KEY`              | api, worker                   | Stripe secret key (a test key outside production)                           |
| `STRIPE_WEBHOOK_SECRET`          | api, worker                   | Stripe webhook signing secret                                               |
| `RESEND_API_KEY`                 | worker                        | Mail provider key (Resend; Brevo or SMTP are set instead when chosen)       |
| `SU_PASSWORD`                    | db (`centcom-<env>-db`)       | Postgres superuser password (postgres-flex)                                 |
| `OPERATOR_PASSWORD`              | db                            | Password of the `postgres` operator account the apps connect with           |
| `REPL_PASSWORD`                  | db                            | Replication password (repmgr)                                               |
| `REDIS_PASSWORD`                 | redis (`centcom-<env>-redis`) | Redis password; the machine's entrypoint reads it                           |

Terraform state credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), `FLY_API_TOKEN` and
`CLOUDFLARE_API_TOKEN` are environment variables of whoever runs Terraform, not Fly secrets.
Each environment has its own organisation, tokens, buckets and passwords: never reuse a value.

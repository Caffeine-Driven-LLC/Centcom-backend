# Account deletion (B026)

How a user deletes their account in the running product, what the worker does at the end, and what is and is not
verified. Wire shapes are the contract's (`CT-API-ACCOUNTS`, `contracts/openapi.yaml`); the module is
[`apps/api/src/modules/account-lifecycle`](../../apps/api/src/modules/account-lifecycle/README.md).

## Flow

| Step         | What happens                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request      | `DELETE /v1/me` (scope `profile`, users only; API keys get 403). 202 `{status: "pending_deletion", scheduled_for, grace_days: 30}`. Every refresh token and device is revoked in the same transaction; access tokens already out fail with `device_revoked` on the next request. 409 for the only owner of a workspace that has other members: transfer ownership or remove the members first. A repeat keeps the first deadline. |
| Grace period | 30 days. The user can sign in again (an account in its grace period is allowed to sign in, so the user can reach the restore route); `GET /v1/me` shows `deletion_scheduled_for`. Signing in does not cancel the deletion.                                                                                                                                                                                                        |
| Cancel       | `POST /v1/me/restore` before the deadline: 200 `User`, the delayed purge job is removed. 409 when nothing is pending, 410 after the deadline.                                                                                                                                                                                                                                                                                     |
| Purge        | The worker's `account-purge` job runs at the deadline (a sweep every hour also queues due ones, so a purge whose job was lost still runs). See below.                                                                                                                                                                                                                                                                             |
| Export       | `POST /v1/me/export`, `GET /v1/me/export/{id}`: only when an object store is configured (`OBJECT_STORE_*`); otherwise these two routes are left out (one log line at boot).                                                                                                                                                                                                                                                       |

## What the purge does (`purgeUser`)

1. Refuses a user who is not pending deletion (`cancelled`), whose deadline is in the future (`not_due`), or who became the only owner
   of a workspace with other members during the grace period (`blocked`, `account_purge_blocked_total`; nothing is deleted, a human decides).
2. Writes the account **tombstone** (`tombstones/account/<usr_id>.json`) to the object store, before anything is destroyed.
3. In one transaction: deletes exports, notifications, notification preferences, push subscriptions, sign-in identities, device grants,
   refresh tokens, the API keys the user created, pending sign-in links to their address and their memberships (except in workspaces
   where they are the only member); scrubs the user row (no e-mail, name or avatar; status `deleted`), revokes and renames devices;
   pseudonymises every audit event that names the user to `usr_deleted` (audit rows are never deleted here; retention is B090); writes `account.purge`.
4. Deletes the workspaces the user was the only member of, the way their owner would (hidden at once, then the `workspace-purge` job
   runs the purge hooks: history, snapshots, invites, entitlements, projects, settings). Until those are gone the result is `waiting`
   and the job retries with backoff (10 attempts).
5. Deletes the user row; when other people's records still point at it (a workspace they created, a session they joined) the scrubbed
   row stays (`scrubbed`).

Shared workspaces are never silently orphaned: at request time the only owner of a workspace with other members is refused (409),
and at purge time the same check blocks the purge.

## Restores do not resurrect an account

`pnpm tombstones:apply` also reads the account tombstones: see [backup and DR](../ops/backup-and-dr.md#deletion-tombstones-workspaces-and-accounts).

## Metrics

`account_deletions_requested_total`, `account_deletions_blocked_total`, `account_deletions_restored_total`, `account_purges_total{outcome}`,
`account_purge_blocked_total`, `account_purge_failed_total` (page on it), `account_tombstones_recorded_total`,
`account_tombstones_skipped_total` (alert: a production purge without a tombstone log), `account_lifecycle_after_commit_failures_total{step}`,
and the export counters. All are in the OTel catalogue (`packages/core/src/otel/catalogue.ts`).

## Verified and not verified

- Verified on Postgres 16, through `buildApp` and the same job services the worker builds
  (`apps/api/test/entrypoint/account-deletion.e2e.test.ts`): the routes exist, 401 and 409 refusals, schedule once and revoke, a repeat keeps the
  deadline, sign-in in the grace period and restore, the purge after the deadline (waiting for the workspace purge, then deleted, a second run
  a no-op), audit pseudonymisation. Tombstones and the restore re-apply: `apps/api/test/tombstones/tombstones.test.ts`.
- Not verified against a real object store, a real BullMQ run of the delayed job, or a real restore from a backup. The queue wiring in
  `main.ts` and `worker.ts` is exercised only by typecheck and the processors' unit tests.
- **Re-authentication is not required**: the contract has none for `DELETE /v1/me`. See
  [the proposal](../proposals/account-deletion-reauth.md).

# Account lifecycle (B026)

Account deletion with a 30-day grace period, and downloadable exports of a user's own data
([CT-API-ACCOUNTS](../../../../../contracts/02-rest-api.md#ct-api-accounts); wire shapes in
`contracts/openapi.yaml`: `AccountDeletion`, `DataExport`, `User`).

## Public interface

| Export                                      | What it is                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accountLifecycleRoutes`                    | `DELETE /v1/me`, `POST /v1/me/restore`, `POST /v1/me/export`, `GET /v1/me/export/{id}`. Register after request-context, error-handler, auth and idempotency. |
| `AccountLifecycleService`                   | `requestDeletion`, `restore`, `cancelDeletion` (for sign-in flows; no HTTP route), `requestExport`, `getExport`.                                             |
| `createAccountLifecycleStore(db)`           | The Postgres store.                                                                                                                                          |
| `AccountExportRunner`                       | `run(exportId, {finalAttempt})` and `sweep(now)`, for the `account-export` job.                                                                              |
| `purgeUser(deps, userId)`, `duePurges`      | The purge and the sweep's query, for the `account-purge` job.                                                                                                |
| `exportBlobStoreFrom(objectStore)`          | The export file store over B082's S3 client (`createS3ObjectStore`).                                                                                         |
| `workspaceDeleterFrom(workspaces, emitter)` | `PurgeDeps.deleteWorkspace` over B027's `WorkspaceService`.                                                                                                  |
| `ACCOUNT_LIFECYCLE_ACTIONS`                 | B036's audit catalogue plus `account.delete_request`, `account.restore`, `account.export`, `account.purge`; create this module's emitter with it.            |

The queues live in `@centcom/worker`: `account-export` (`enqueueAccountExport`,
`startAccountExportWorker`, a sweep every 15 minutes) and `account-purge` (`scheduleAccountPurge`,
`cancelAccountPurge`, `startAccountPurgeWorker`, a sweep every hour). The service's `AccountJobs`
port is those three functions over the two queues.

## Behaviour

- **Delete.** One transaction locks the user, refuses (409) the only owner of a workspace that has
  other members, sets `deletion_requested_at`, `deletion_scheduled_at` (+30 d, kept on a repeat)
  and status `pending_deletion`, and revokes every refresh token and device. After the commit the
  token service flags the devices and the user in Redis (old access tokens get `device_revoked`)
  and the purge job is delayed until the deadline.
- **Restore.** `POST /v1/me/restore` before the deadline: 200 `User`, purge job removed; nothing
  pending: 409; deadline passed: 410 `gone`. The user must sign in again (their tokens were
  revoked); sign-in flows may call `cancelDeletion` instead.
- **Export.** One per 24 hours (a failed one does not count): 429 with `Retry-After` otherwise.
  The job writes `exports/<usr>/<exp>.json` (profile, devices with fingerprints, own memberships,
  API-key metadata, notification preferences, own audit events up to 10 000), ready for 7 days;
  `running` shows as `pending`. A ready export's `download_url` is a GET-only URL valid 900 s (never
  past the file's expiry). Allowed during a pending deletion.
- **Purge** (`purgeUser`): see the module comment in `purge.ts`. Personal rows are hard-deleted and
  audit rows pseudonymised to `usr_deleted` in one transaction; workspaces the user was alone in
  are deleted through B027; then the user row is deleted, or kept scrubbed (no e-mail, name,
  avatar; status `deleted`) while other people's records still reference it.

## Config

None of its own: the grace period (30 d), export window (24 h), URL lifetime (900 s), file
lifetime (7 d) and audit cap (10 000) are constants from the card and the contract. The object
store uses B082's `AUDIT_EXPORT_S3_*` settings (`audit-api/config.ts`); exports go in the same
bucket under `exports/`.

## Failure modes

| Failure                              | Behaviour                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Database timeout or lost connection  | 503 `service_unavailable` with `retry_after_s`.                                                                      |
| Redis or the queue fail after commit | The request still succeeds; `account_lifecycle_after_commit_failures_total{step}` counts it; the sweeps catch up.    |
| Export build or upload fails         | Retried 5 times (exponential, jitter); then `failed` (`storage_unavailable` or `internal`), no file left.            |
| Purge fails halfway                  | Each step is idempotent; the job retries (10 attempts), then `account_purge_failed_total`; the user stays scheduled. |
| Sole owner at purge time             | `blocked`: nothing deleted, `account_purge_blocked_total`; a human decides.                                          |

Metrics: `account_deletions_requested_total`, `account_deletions_blocked_total`,
`account_deletions_restored_total`, `account_exports_requested_total`,
`account_exports_limited_total`, `account_exports_written_total`, `account_exports_failed_total{code}`,
`account_exports_expired_total`, `account_purges_total{outcome}`, `account_purge_blocked_total`,
`account_purge_failed_total`. Logs carry ids and outcomes only, never a URL or the document.

## Testing

`apps/api/test/account-lifecycle/`: routes, authz, export runner and adapters run in memory;
`account-lifecycle.postgres.test.ts` and `account-purge.job.test.ts` need `DATABASE_URL` (CI's
integration job). Worker jobs: `apps/worker/test/account-jobs.test.ts`.

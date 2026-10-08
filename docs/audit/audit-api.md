# Audit log API and exports

Lane B082 ([CT-API-AUDIT](../../contracts/02-rest-api.md)). A workspace's owners and admins read
its audit log, filtered and paginated, and export it as CSV or JSON. The events come from B036's
emitter (`audit_events`); retention purges are B090's.

## Endpoints

All three need scope `audit:read` and the `audit.read` RBAC action: owners and admins, or an API key
of the workspace holding `audit:read`. Anyone else who is a member (member, guest, billing) gets 403
`forbidden`, and the refusal is audited as `permission.denied`. A non-member, another workspace's
key, or an unknown workspace gets 404.

| Method | Path                                      | Answer                                                  |
| ------ | ----------------------------------------- | ------------------------------------------------------- |
| GET    | `/v1/workspaces/{id}/audit`               | 200, CT-PAGE of `AuditEvent`, newest first              |
| POST   | `/v1/workspaces/{id}/audit/exports`       | 202, `AuditExport` (pending), `Location` its status URL |
| GET    | `/v1/workspaces/{id}/audit/exports/{exp}` | 200, `AuditExport` with a download URL once ready       |

### Listing

`GET /v1/workspaces/{id}/audit?actor=&action=&from=&to=&limit=&cursor=`

| Filter   | Value                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| `actor`  | a `usr_`, `key_` or `dev_` id; anything else is 422 at `/actor`                            |
| `action` | an exact action name (`member.role_change`); one nobody wrote gives an empty page, not 422 |
| `from`   | RFC 3339, inclusive                                                                        |
| `to`     | RFC 3339, exclusive. `from` after `to` is 422 at `/from`                                   |

Filters combine with AND. `limit` is 1 to 200 (default 50). Cursors are B025's: signed, valid for
24 hours, and bound to the workspace and the filters, so a cursor used with other filters, in
another workspace, tampered with or expired is 400 `cursor_invalid`. Events arriving while a client
pages are newer than its cursor, so a walk through the pages returns every older event exactly once.

Reading the log writes no audit event.

### The event

CT-API-AUDIT's `AuditEvent`: `id`, `workspace`, `at`, `actor {type, id}`, `action`,
`target {type, id}` (absent when the event has none), `result`, `metadata`.

- `actor.type` is `user`, `api_key` or `system` (a system actor's id is the service, `retention`).
  The contract has no device actor: a device's event shows as `user` with its `dev_` id.
- `result` is `allowed` for a successful action and `denied` for a refused one; a failed one has
  no `result`.
- `metadata` holds the action's allowlisted meta only (ids, enums, counts, flags, times), cut to
  the allowlist again when read. No IP address, user agent, e-mail address or free text is shown.

### The plan

The workspace's `audit_log_days` entitlement decides what is visible: only events from the last
`audit_log_days` days are read, even when older ones are still stored (B090 purges them later).
The horizon is a condition of every SQL statement, not a filter applied afterwards. With
`audit_log_days = 0` the plan has no audit log: the list and new exports answer 403
`entitlement_required`. A member below admin gets `forbidden` before the plan is looked at.

## Exports

`POST /v1/workspaces/{id}/audit/exports` with `{format: 'csv'|'json', actor?, action?, from?, to?,
gzip?}`. `Idempotency-Key` is accepted: the same key and body return the same export (replayed with
`Idempotency-Replayed: true`); the same key with another body is 409.

1. The matching events are counted, stopping at the cap. More than `AUDIT_EXPORT_MAX_ROWS` is 422
   at `/from`: narrow the range.
2. The export row and an `audit.export` event (target the export; meta `format`, `gzip`, and the
   names of the filters given) are written in one transaction.
3. The job is queued on `audit-export` (job id the export id). If queueing fails the export stays
   pending and the worker's sweep queues it within about 5 minutes; the request still answers 202.

The export covers the matching events up to the moment it was requested (and within the plan's
retention then), so a retried job writes the same file.

### The worker

`apps/worker/src/jobs/audit-export/`, queue `audit-export`:

- An `export` job has 3 attempts, 10 s apart. Each attempt marks the export running, deletes
  whatever an earlier attempt left at the export's object key, streams the events in keyset batches
  of 5 000 through the CSV or JSON writer (and gzip when asked) into a temporary file, uploads the
  finished file in one PUT, and marks the export ready. The temporary file is always deleted.
- Past `AUDIT_EXPORT_MAX_ROWS` rows the export fails at once with `row_cap_exceeded` (no retry).
- The last attempt that fails marks the export failed, `storage_unavailable` when the object store
  failed, else `internal`, and deletes any object it left.
- A `sweep` job every 5 minutes deletes the files of exports past their expiry and marks them
  `expired`, queues again exports still pending after 2 minutes, and fails (`internal`) exports
  still unfinished an hour after their request: every attempt of their job failed before the
  export could be marked (Postgres down), so they would otherwise stay pending.

### Files

| Format | Object key                                    | Content type                                   |
| ------ | --------------------------------------------- | ---------------------------------------------- |
| CSV    | `audit-exports/<wsp>/<exp>.csv` (`.csv.gz`)   | `text/csv; charset=utf-8` (`application/gzip`) |
| JSON   | `audit-exports/<wsp>/<exp>.json` (`.json.gz`) | `application/json` (`application/gzip`)        |

- **CSV:** columns `id, at, workspace, actor_type, actor_id, action, target_type, target_id, result,
metadata` (the metadata as JSON text); CRLF line ends; cells with a comma, quote, CR or LF are
  quoted with quotes doubled (RFC 4180). A cell beginning with `=`, `+`, `-` or `@` (or a tab or CR)
  is prefixed with `'`, so a spreadsheet never runs it as a formula.
- **JSON:** an array of `AuditEvent`s, one per line.

### Status and download

`GET .../exports/{exp}` answers the contract's `AuditExport`:

| `status`  | Meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `pending` | queued or being written (the worker's `running` shows as `pending`: the contract has none) |
| `ready`   | `download_url` and `expires_at` (when the file is deleted) are set                         |
| `failed`  | `failure_reason`: `row_cap_exceeded`, `storage_unavailable` or `internal`                  |
| `expired` | the file is gone (24 hours after it was written)                                           |

Two fields are added to the contract's object: `row_count` once known, and `failure_reason`.

`download_url` is a pre-signed S3 URL that can only GET that one file (host is its only signed
header; any other method is refused by the store), valid for `AUDIT_EXPORT_URL_TTL_S` (900 s) or
until the file expires, whichever comes first. Each status request signs a fresh one. The file
downloads as `audit-<exp>.csv` (or `.json`, `.gz`).

The status route is not gated by the plan (CT-API-AUDIT lists no `entitlement_required` for it), so
a workspace that drops to `audit_log_days = 0` can still fetch an export made before, until its
file expires.

## Configuration

| Key                              | Default     | Meaning                                                     |
| -------------------------------- | ----------- | ----------------------------------------------------------- |
| `AUDIT_EXPORT_MAX_ROWS`          | `1000000`   | Most events one export holds (1 to 1 000 000)               |
| `AUDIT_EXPORT_URL_TTL_S`         | `900`       | Lifetime of a download URL, seconds (1 to 900)              |
| `AUDIT_EXPORT_RETAIN_H`          | `24`        | Hours an export file is kept after it is written (1 to 168) |
| `OBJECT_STORE_ENDPOINT`          |             | Base URL of the S3 API (R2; `http://127.0.0.1:9000` MinIO)  |
| `OBJECT_STORE_REGION`            | `us-east-1` | Signing region (`auto` for R2)                              |
| `OBJECT_STORE_BUCKET`            |             | Bucket for exports (the development stack's `exports`)      |
| `OBJECT_STORE_ACCESS_KEY_ID`     |             | Secret                                                      |
| `OBJECT_STORE_SECRET_ACCESS_KEY` |             | Secret                                                      |

The exports bucket needs no public access: every download goes through a pre-signed URL. A
lifecycle rule that deletes objects under `audit-exports/` after 2 days is a cheap backstop for the
sweep.

## Indexes and speed

`audit_events` is read newest first by `(created_at, id)`:

- no `actor` or `action` filter: B036's `(workspace_id, created_at desc, id desc)`;
- `actor`: `(workspace_id, actor_id, created_at desc, id desc)`;
- `action`: `(workspace_id, action, created_at desc, id desc)`.

A page of 200 by actor in a workspace of 1 000 000 events stays under 150 ms at the 95th
percentile, and each filter's plan is a scan of its index without a sort (checked by EXPLAIN in
`audit.perf.test.ts`). An export of 100 000 events completes well within 60 s.

## Failure modes

| What                              | Effect                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| Object storage down               | Exports retry 3 times, then fail with `storage_unavailable`; the list works |
| Range too large                   | 422 at `/from` before anything is stored                                    |
| Cursor from other filters         | 400 `cursor_invalid` (problem+json)                                         |
| Worker killed mid-export          | The job is retried; the next attempt removes any partial object first       |
| Queue (Redis) down at the request | 202 all the same; the sweep queues the export                               |
| Postgres timeout or connection    | 503 with `retry_after_s`                                                    |

## Not here

Purging expired audit rows (B090), staff views of audit data (B087), and webhooks or notifications
of audit events.

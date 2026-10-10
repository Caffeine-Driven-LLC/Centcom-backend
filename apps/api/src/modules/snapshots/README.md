# Session snapshots (B056)

Encrypted state checkpoints that the host's client builds and uploads, so a client that fell out of
the relay's hot buffer can catch up from the newest one
([CT-RESUME](../../../../../contracts/03-ws-envelope.md#ct-resume--history-replay-snapshots)).
The routes are `POST /v1/sessions/{id}/snapshot`, `POST .../snapshot/{snp}/commit` and
`GET /v1/sessions/{id}/snapshot`
([CT-API-SESSIONS](../../../../../contracts/02-rest-api.md#ct-api-sessions); shapes
`SnapshotBegin`, `SnapshotUpload`, `SnapshotCommit` and `SnapshotDescriptor` in `openapi.yaml`). The
server never reads a snapshot beyond its size and SHA-256.

## Public interface

| Export                                           | What it is                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `SnapshotService.begin(sid, byMember, {size})`   | Host only: a `snp_` id, a pending row and a pre-signed PUT of exactly `size` bytes (<= 32 MiB), 600 s.    |
| `SnapshotService.commit(sid, snp, body, member)` | Host only: hashes the uploaded object as a stream and marks it committed; prunes to 3.                    |
| `SnapshotService.latest(sid)`                    | The committed snapshot with the highest seq and a pre-signed GET (300 s), or null. No caller check.       |
| `SnapshotService.latestFor(sid, caller)`         | `latest` for a participant (the route).                                                                   |
| `SnapshotService.purgeSession(sid)`              | Deletes every snapshot of the session, objects first (for B090's retention and workspace purge).          |
| `SnapshotService.pruner.prune()`                 | Deletes uploads pending over 15 min and finishes deletions that stopped halfway (for a periodic job).     |
| `snapshotSeqLookup(service)`                     | The relay's `SnapshotLookup` (`apps/relay/src/resume/types.ts`) over `latest`.                            |
| `createSnapshotRepository(db)`                   | The `snapshot` table over Postgres.                                                                       |
| `createS3SnapshotObjects(config)`                | Pre-signed URLs and the streamed read over S3/R2 (`OBJECT_STORE_*`), with B055's `BlobStore` for deletes. |
| `snapshotRoutes`                                 | The three routes (`routes/snapshots/index.ts`).                                                           |

## What is stored

- **Row** (`snapshot`): `snp, session_id, state, seq, size, sha256, kid, blob_key, created_at,
committed_at`. Nothing else: `snapshots.privacy.test.ts` fails when a column appears.
- **Object**: `snapshots/<ses_>/<snp_>.bin`, the client's ciphertext as uploaded. The key is
  always the server's, never the client's.
- `state` is `pending` (begun, not verified), `committed`, or `deleting` (being pruned; never
  served).

## Rules

- **Who:** the host begins and commits (an editor or viewer: 403 `host_required`); any participant
  (host, editor, viewer) reads; anyone else, or an unknown session: 404. API keys: 403. The standing
  comes from B055's `HistoryAccess`.
- **Begin:** `size` is required (the PUT can only be capped by signing its exact length) and at
  most 33 554 432. At most 3 uploads may be pending per session (pending rows younger than 15 min);
  more is 429 `rate_limited`, with `retry_after_s` until the oldest of them stops counting.
- **Commit:** the body's `size` must equal begin's and the object's; its `sha256` (`sha256:<hex>`,
  CT-IDS) the object's. A body `size` other than begin's is 422 `validation_failed` at `/size` before
  anything is read (the object is kept; the host may retry with the right size). A hash mismatch
  is 409 `snapshot_hash_mismatch` (CT-ERR) with `errors[0].pointer` `/sha256`, an object of another
  size 422 at `/size`: the object is deleted and the row stays pending. The row is claimed
  (`deleting`) while its object goes, so a concurrent commit of it cannot commit a missing
  object; if one already won, its descriptor is the answer. No object: 404 `snapshot_missing`. The store failing: 503 with `retry_after_s`.
  Committing the same values again answers the same descriptor.
- **Latest:** the highest seq wins (a lower seq committed later is stored, not served); newest
  commit on a tie. None: 404 `snapshot_missing`, and `latest()` is null for the relay.
- **Keep 3:** after each commit, the session keeps the latest snapshot (the one GET serves) and
  the 2 most recently committed others; older ones are deleted (so a lower seq just committed is
  stored). The row is marked `deleting`, then the object goes, then the row. A failure leaves the
  row `deleting`; the session's next commit, or `prune()`, finishes it. Each commit also expires
  its session's uploads pending over 15 min; `prune()` does it for every session.
- **Idempotency:** both POSTs accept `Idempotency-Key` (B024); begin's stored answer is encrypted
  (it holds the URL). Every answer is `Cache-Control: private, no-store`.
- **Audit:** `snapshot.begin` and `snapshot.commit` (meta: `session_id`, `seq`, `size`), written in
  the transaction of the row change by an emitter over `SNAPSHOT_AUDIT_ACTIONS`.
- **Logs and metrics** never carry a URL, a signature, a hash or content.

## Config

The object store settings are B082's (`OBJECT_STORE_ENDPOINT`, `_REGION`, `_BUCKET`,
`_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`). The limits are constants from the card (`ports.ts`):
32 MiB, PUT 600 s, GET 300 s, keep 3, pending 15 min, 3 pending per session, 64 KiB read chunks.
A read's own URL lives 60 s and a read gives up after 30 s without progress.

## Metrics

`snapshot_requests_total{op,outcome}`, `snapshot_pruned_total{reason}`,
`snapshot_prune_failures_total`, `snapshot_verify_failures_total`.

## Failure modes

| Failure                              | Behaviour                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Object store down during commit      | 503 `retry_after_s`; the row stays pending; the client retries the commit.     |
| No object at commit                  | 404 `snapshot_missing`; the row stays pending until it is uploaded or expires. |
| Prune fails after deleting an object | The row stays `deleting` (never served); the next `prune()` deletes it.        |
| Begin storm (10 in 1 s)              | 3 pending rows; the rest 429 with `retry_after_s`.                             |
| Database down                        | 503 `retry_after_s`.                                                           |

## Known limits

- The upload URL stays valid for its 600 s after a commit: the host could overwrite a committed
  object with other bytes of the same size. Clients check `sha256` after download (CT-RESUME).
- On AWS S3, credentials without `s3:ListBucket` get 403 for a missing object; the commit then
  answers 503 instead of 404 `snapshot_missing`. Grant ListBucket on the bucket (R2 and MinIO
  answer 404 either way).
- Nothing schedules `prune()` yet (uploads abandoned in a session that never commits again stay
  until it runs), and B090 does not call `purgeSession` yet.

## Testing

`pnpm test` runs `apps/api/test/snapshots/`: the service, routes and pruning over in-memory rows and
objects whose URLs are the real pre-signed ones (a fake store checks them as S3 does), the S3 read
against a local server, and, where Docker runs, MinIO. `snapshots.postgres.test.ts` runs in CI's
integration job (`DATABASE_URL`).

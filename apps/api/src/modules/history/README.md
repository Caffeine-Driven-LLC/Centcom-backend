# Durable session history (B055)

The durable log of a session's sequenced ciphertext frames
([CT-RESUME](../../../../../contracts/03-ws-envelope.md#ct-resume--history-replay-snapshots)),
served by `GET` and `DELETE /v1/sessions/{id}/history`
([CT-API-SESSIONS](../../../../../contracts/02-rest-api.md#ct-api-sessions); shapes `HistoryPage` and
`HistoryFrame` in `openapi.yaml`). The server stores ciphertext only and cannot read it.

## Public interface

The store, its blob stores and the writer live in [`@centcom/storage`](../../../../../packages/storage/README.md)
since B042, because the relay writes and reads the same log; this module keeps the service
behind the routes and re-exports the rest.

| Export                                                    | What it is                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `HistoryWriter`                                           | `add(sid, frame)` for each sequenced frame; resolves once it is durable (the relay's ack). Batches 500 frames or 2 s. |
| `createHistoryStore({db, blobs})`                         | `append`, `read`, `purge`, `setExpiry`, and `repair(sid)` for crash recovery.                                         |
| `toStoredFrame(frame)`                                    | What the log keeps of a sequenced frame, or why it keeps none.                                                        |
| `BlobStore`, `createS3BlobStore`, `createMemoryBlobStore` | The blob port: S3/R2 (B082's signer, `OBJECT_STORE_*` settings) and in-memory.                                        |
| `HistoryService`, `createPostgresHistoryAccess`           | Who may read or purge; the routes are `routes/history/index.ts` (`historyRoutes`).                                    |
| `retentionExpiry(endedAt, historyDays)`                   | The `expires_at` to pass to `setExpiry` when a session ends (B053 calls it; B090 purges).                             |

## What is stored

- **Index** (`history_index`, Postgres): `session_id, seq, msg_id, member_id, ts, kind_class, size,
kid, blob_key`. Nothing else, ever: a test fails if a column is added.
- **Blobs**: `history/<ses_>/<first seq>-<last seq>.bin`, newline-delimited JSON, one frame per
  line: `seq, id, from, ts, kindClass, ref, k, kid, ct, p, sig`. `ct` is written as received and
  read back byte for byte. `ref` (an id, kept since B042) lets the relay replay a frame exactly as
  it was delivered; the REST `HistoryFrame` does not return it.
- **Which frames:** `event`, `queue` and `control` only. `presence`, `sys.*` and acks are never
  stored.
  - Encrypted kinds: no `p`. A frame of an encrypted kind that carries a non-empty `p` is refused
    and counted (`history_frames_refused_total`).
  - Clear and hybrid kinds: only the contract's clear fields of `p`.
  - Unknown kinds: `ct` only.
- **Retention** (`history_retention`): `expires_at` per session, for B090's job.

**Encryption at rest:** enable it on the bucket. R2 encrypts every object at rest. On S3, set the
bucket's default encryption (SSE-S3 or SSE-KMS). On MinIO, configure KMS and auto-encryption. The
store sends no per-object header, so every object follows the bucket's setting.

## Rules

- **Reads** return contiguous frames from the first one after `after_seq` (or from the earliest
  retained frame, given as `earliest_seq`), stopping at a gap. A page whose blobs cannot all be read
  is a 503 (`retry_after_s`), never a partial page. Cursors are signed and bound to the session.
- **Who:**

  | Caller                              | GET                              | DELETE              |
  | ----------------------------------- | -------------------------------- | ------------------- |
  | host                                | 200                              | 204                 |
  | editor, viewer                      | 200                              | 403 `host_required` |
  | workspace owner (not a participant) | 404                              | 204                 |
  | share-link guest (B068)             | 200 if `share_history`, else 403 | 404                 |
  | anyone else, unknown session        | 404                              | 404                 |

  "Share history" is the workspace's setting until per-session policies (B051) are stored.

- **Purge:** for each blob, the blob is deleted first and then its index rows, followed by the
  retention row, and one `history.purge` audit event is written. If a purge fails partway the
  answer is 503: it is resumable, and reads in between see only frames whose blob is still there.
- **Crash between flush and index:** the relay retries un-acked frames, and a retry writes the same
  key. `repair(sid)` indexes blobs that were never indexed, without duplicate rows.

## Config

The blob store reuses B082's object store settings (`OBJECT_STORE_ENDPOINT`, `_REGION`, `_BUCKET`,
`_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`). These limits are constants from the card:

- batches hold 500 frames and wait at most 2 s;
- a failed write gets 5 attempts with jittered waits from 200 ms;
- pages hold 1-200 frames.

## Failure modes

| Failure                      | Behaviour                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Blob put fails               | Retried 5 times (backoff + jitter). Then every waiting `add` rejects, so the relay keeps the frames; `history_append_failures_total`. |
| Blob get fails on read       | 503 with `retry_after_s`; `history_read_failures_total`.                                                                              |
| Purge fails partway          | 503; retry the DELETE to finish; `history_purge_failures_total`.                                                                      |
| Encrypted frame carrying `p` | Refused, counted, and logged with kind and session only.                                                                              |

Logs never carry `ct`, `p` or a key's content: only the session, kind, counts and error kinds.

## Testing

`apps/api/test/history/`:

- **No database needed:** `history.authz`, `history.writer`, `history.privacy` (frame rules, logs)
  and the memory half of `history.blobstore.contract`.
- **`DATABASE_URL`:** `history.append-read`, `history.purge`, `history.crash-recovery` and the
  schema allow-list.
- **Container runtime:** the MinIO half of `history.blobstore.contract`.

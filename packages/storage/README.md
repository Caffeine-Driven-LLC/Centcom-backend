# @centcom/storage

Object storage and the durable session history log, shared by the API and the relay. It was split
out of `apps/api` by B042, because the relay writes every sequenced frame to the log and reads it
back to replay and recover sessions. Code moved here unchanged except for `ref` (below).

| File                   | What it is                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `object-store.ts`      | The `OBJECT_STORE_*` settings (`objectStoreEnvShape`, `loadObjectStoreConfig`): R2 or MinIO.     |
| `sigv4.ts`             | AWS Signature Version 4: signed headers and pre-signed URLs (B082).                              |
| `blob-store.ts`        | The `BlobStore` port, history keys and the batch format (B055).                                  |
| `s3-blob-store.ts`     | `createS3BlobStore`: the port over S3/R2/MinIO (B055).                                           |
| `memory-blob-store.ts` | `createMemoryBlobStore`: in-memory, for tests (B055).                                            |
| `store.ts`             | `createHistoryStore`: append, read, purge, repair; `toStoredFrame`; the workspace purger (B055). |
| `writer.ts`            | `HistoryWriter`: batches frames into the store, retried (B055).                                  |
| `ports.ts`             | The types: `StoredFrame`, `HistoryStore`, `HistoryAccess`.                                       |

Who uses it:

- **API (`apps/api/src/modules/history`):** re-exports it, and keeps the REST service.
- **Audit exports (`audit-api`):** use the signer and the object store settings.
- **Relay (`apps/relay/src/resume`):** wires the store and writer into sequencing and replay.

## `ref`

Since B042 the log keeps a frame's `ref` (an id, never content) in its blob, so the relay replays
the frame exactly as it was delivered. A malformed `ref` makes the frame invalid, like a malformed
`id`. The Postgres index is unchanged, and the REST `HistoryFrame` does not return it.

## Config

| Key                              | Default     |                                             |
| -------------------------------- | ----------- | ------------------------------------------- |
| `OBJECT_STORE_ENDPOINT`          |             | `https://` (or `http://`) base URL          |
| `OBJECT_STORE_REGION`            | `us-east-1` | Signing region (`auto` for R2)              |
| `OBJECT_STORE_BUCKET`            |             | The bucket (audit exports, session history) |
| `OBJECT_STORE_ACCESS_KEY_ID`     |             | Secret                                      |
| `OBJECT_STORE_SECRET_ACCESS_KEY` |             | Secret                                      |

## Testing

- `packages/storage/test`: `ref` and the settings.
- The store, writer and blob stores keep their B055 tests in `apps/api/test/history` (they run
  against the API's routes and Postgres).
- The relay's round trip is `apps/relay/test/resume/resume.durable-log.test.ts`.

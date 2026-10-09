# Resume and replay (B042)

A reconnecting client gets the sequenced frames it missed, then `sys.resumed`, then live traffic,
with no gap and no duplicate between them
([CT-RESUME](../../../../contracts/03-ws-envelope.md#ct-resume--history-replay-snapshots),
[CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Handshake"). A session that Redis lost is
recovered from the durable log before anything else is numbered. It is a relay module
(`module.ts`, order 45) and sets `ctx.resume` for the handshake.

## Parts

| File             | What it does                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `resume.ts`      | `createResumer`: the plan, the batched replay, the live-frame handoff, `sys.resume` (stage at 45).              |
| `hydrate.ts`     | `createHydrator`: recovers a lost session from the durable log; B041's readiness gate.                          |
| `durable-log.ts` | B055's store as the `DurableLogReader` and B041's `DurableAppend` (`historyLogReader`, `historyDurableAppend`). |
| `types.ts`       | The ports: `DurableLogReader`, `SnapshotLookup` (B056; none until then), `ResumeResult`.                        |
| `config.ts`      | `RELAY_REPLAY_BATCH`, `RELAY_REPLAY_MAX_FRAMES`, `RELAY_HYDRATE_FRAMES` and the object store.                   |
| `module.ts`      | Wiring: the durable log, the hydrator, the resumer, `ctx.resume`.                                               |

## Flow

1. **Hello.** The handshake verifies the ticket and the live membership first: a revoked member is
   closed 4403 and gets nothing. Then:
   - `hold`: before the room join, fan-out starts holding the connection's live frames;
   - `prepare`: before the welcome, the session is recovered if it must be (below), and the replay
     is planned. The plan goes in `welcome.resume`;
   - `start`: after the welcome, the replay runs.

   A failure in `prepare` closes the connection with `service_unavailable` (4503).

2. **Plan**, for `last_seq` = L and the store's head = H:

   | Case                                                        | Answer                                                                                                         |
   | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | L = null                                                    | Nothing replayed, `welcome.resume` null, no `sys.resumed`.                                                     |
   | L within the hot buffer, or L = H                           | L+1..H replayed, then `sys.resumed {from_seq, to_seq, count}` (`count: 0` for L = H).                          |
   | L older than the buffer, and a snapshot newer than L exists | `sys.resumed {snapshot_required: true, snapshot_seq}`, no frames.                                              |
   | L > H, or H − L > `RELAY_REPLAY_MAX_FRAMES`, and a snapshot | The same `snapshot_required` answer (any snapshot when L > H).                                                 |
   | L older than the buffer, no usable snapshot                 | L+1..H from the durable log and the buffer; `history_gap: true` if frames after L are gone (CT-RESUME Flow 4). |
   | L > H or the window too long, no snapshot                   | The newest `RELAY_REPLAY_MAX_FRAMES` frames, with `history_gap: true`. The client rebuilds from them (Flow 5). |

   `welcome.resume` is the plan: `{from_seq, to_seq}` or `{snapshot_required, snapshot_seq}`.

3. **Replay.**
   - Frames are read in batches of `RELAY_REPLAY_BATCH`. A batch comes from the hot buffer when it
     still holds the batch's first frame, else from the durable log.
   - Each frame is sent as the exact JSON first delivered.
   - Before each frame, while the outbound buffer would pass 2 MiB, the replay waits for it to
     drain (B046's `whenDrained` when the relay has it, else polling). A client that reads nothing
     for 30 s is closed **4429** (`slow_consumer`); with B046, its 5 s grace closes it first.
4. **Handoff.**
   - After `sys.resumed`, the held live frames above the last replayed `seq` are sent in order.
   - The hold ends in the same turn as the last one is taken, so nothing is missed.
   - A live frame of the replayed range that fan-out releases late is skipped.
   - A resend's echo (B041 duplicate) is held the same way while the replay runs.
5. **Later `sys.resume {last_seq}`** (after `snapshot_required`, or whenever the client wants) runs
   steps 2-4 on the open connection. A second one while one runs is `sys.error invalid_frame`, and
   is ignored. A malformed `last_seq` is `invalid_frame` too.

Replay never crosses sessions: it uses the connection's session (the ticket's), never a frame's
`sid`.

## Hydration

The first connection of a session on a node, or its first sequenced frame there, checks the store.
Head 0 while the durable log has frames means Redis lost the session. The counter is then set to
the log's head, and the newest `RELAY_HYDRATE_FRAMES` frames go back into the buffer, atomically
(`SeqStore.hydrate`). Only frames that reach the head with no hole are put back, at most 16 MiB of
them. The next frame gets head+1, never 1.

Sequencing waits on this per session (B041's `setReadiness`). If recovery fails, that session's
frames are refused with `service_unavailable` (sequencing paused) and `relay_hydrate_failed_total`
counts it for alerting. A session found sound is remembered on the node, up to 100 000 sessions.

## Durable log

With `OBJECT_STORE_*` set, every sequenced frame goes to B055's history store through a
`HistoryWriter`: batches of 500 or 2 s, retried, and flushed on shutdown. Replay and hydration read
the same store. The store keeps `ref` too (since B042), so a frame replayed from the log is
byte-identical to the one first delivered (`relayFrameOf`). The store and writer live in
`@centcom/storage`, shared with the API.

Without an object store (development and tests) only the hot buffer is replayed and nothing is
recovered after a flush. The relay logs `relay.resume_without_durable_log`, and refuses to start
this way in production.

## Config

| Key                       | Default | Rule                                                           |
| ------------------------- | ------- | -------------------------------------------------------------- |
| `RELAY_REPLAY_BATCH`      | `100`   | 1 to 1 000 frames                                              |
| `RELAY_REPLAY_MAX_FRAMES` | `50000` | 1 to 1 000 000; a longer window is `snapshot_required`         |
| `RELAY_HYDRATE_FRAMES`    | `5000`  | 0 to 20 000 frames put back on recovery                        |
| `OBJECT_STORE_*`          |         | `@centcom/storage`'s keys, all or none; required in production |

## Metrics

- `relay_resume_total{result}`: `replayed`, `snapshot_required`, `failed`, `busy`.
- `relay_resume_duration_seconds{result}`: `ok` or `failed`, from the hold to `sys.resumed`. This
  feeds the resume-success SLO.
- `relay_replay_frames_total{source}`: `hot` or `durable`.
- `relay_resume_stalled_total`: replays stopped with 4429.
- `relay_hydrated_total`, `relay_hydrate_failed_total` (alert).

Logs carry the session, modes and counts, never `p`, `ct`, `sig` or ids.

## Limits

- **A full Redis flush while connections of a known session stay open is not detected:** the
  session is remembered as sound on that node, so its counter would restart. Relays usually lose
  their sockets with Redis. A follow-up could pass the node's known head to B041's assign script
  so it refuses to restart a counter.
- **Dedupe records are lost with Redis too:** a resend after a flush is sequenced again.
- **Frames not yet durable when Redis lost them are gone** (the writer batches up to 2 s): clients
  that had them see `history_gap` or are ahead of the head.
- **No snapshots until B056:** `noSnapshots` means `snapshot_required` is never sent.

## Testing

`apps/relay/test/resume/`:

- `resume.replay`: the window, exact counts and order (20 runs with traffic during the replay),
  empty replays, byte-identical frames, metrics.
- `resume.handoff`: a fast-check property over random interleavings of live frames, resends and
  turns; hold overflow; late frames.
- `resume.snapshot-required`: old, future and null `last_seq`, the follow-up `sys.resume`, the
  50 000 cap, no snapshot (durable replay, `history_gap`), failures, concurrent and malformed
  `sys.resume`.
- `resume.hydrate`: recovery after a flush (acceptance 8), sequencing waiting for it, recovery
  failing, what is put back, and `SeqStore.hydrate` on the in-memory store and Redis 7.
- `resume.backpressure`: 5 000 frames never over 2 MiB, under 2 s; a client that never reads.
- `resume.durable-log`: `relayFrameOf` byte identity, the adapters, and a round trip through B055 on
  Postgres 16.
- `resume.relay`: SimClients on a running relay (acceptance 1, 5, 7, Flow 3, envelope validity,
  4503 on failed recovery).
- `resume.module`: wiring and settings.

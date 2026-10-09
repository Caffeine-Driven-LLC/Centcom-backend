# Sequencing, acks and the hot buffer (B041)

Gives every sequenced frame of a session its place
([CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Sequencing and delivery guarantees"
and "Limits"): a strictly increasing, gapless `seq` per session, dedupe of resends, the echo
that acknowledges a send, client acks, the per-member rate limit and the hot buffer replay reads
from. It is a relay module (`module.ts`, order 40) and sets `ctx.seq` for the modules after it.

## The stage

For an authenticated connection's decoded frames (`stage.ts`):

| Frame                                 | What happens                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`, `queue`, `control`           | Spends a token of the member's bucket; then, in the connection's arrival order, the store assigns the `seq` atomically with the dedupe check and the buffer append. The frame gets the server's `from` (the connection's member), `ts` and `seq`, is echoed to the sender, handed to the durable append and passed on to fan-out |
| a resend of `(sid, from, id)` (24 h)  | Echoed with its original `seq` and `ts`; not passed on, not appended again                                                                                                                                                                                                                                                       |
| `t: "ack"`                            | Moves the connection's `acked_seq` up; consumed                                                                                                                                                                                                                                                                                  |
| `ack` on any frame                    | The same, and the frame goes on                                                                                                                                                                                                                                                                                                  |
| an ack beyond the head                | `sys.error invalid_frame` (pointer `/ack`), `acked_seq` unchanged; a sequenced frame carrying it is dropped; the 11th within 60 s closes **4400**                                                                                                                                                                                |
| everything else (`presence`, `sys.*`) | Passed on untouched                                                                                                                                                                                                                                                                                                              |

The frame passed on is in `fc.state[SEQUENCED_STATE_KEY]`. Its fields are in envelope order and
its `p`, `ct`, `sig`, `ref` and `k` are what the sender sent; only the client's `ack` is
consumed (CT-CRYPTO does not sign it, and it says nothing to other members). A client-sent
`from`, `ts` or `seq` never survives (the codec strips them, and the stage stamps its own).
Replies about one frame carry its `id` as `ref`.

Until fan-out (B044) takes it over (`delegateEcho()`, which its module calls), the sender's echo
is this module's. After that, fan-out delivers a new frame to every connection of the room, the
sender's included, strictly in `seq` order; this stage still echoes a resend (duplicate) itself.

### Bounds

- **Waiting frames:** at most `RELAY_SEQ_BURST` sequenced frames of one connection wait for the
  store (in its arrival order). Past that the frame is refused at once with
  `sys.error service_unavailable` (`retry_after_s` 1) and `sys.slow_down`, never queued.
- **Store failures:** for 1 s after the store failed, sequenced frames are refused the same way
  without calling it, so a Redis outage costs no waiting.
- **Closed connections:** frames still waiting when their connection closes are dropped; the
  client resends them with the same `id` after reconnecting.
- **Acks** never wait behind sequenced frames. An ack within the head this node has seen is taken
  at once; per connection at most one ack waits for the store's head, and later ones only raise
  the value it waits with.

Every authenticated connection is tracked (bucket, `acked_seq` 0) from its first frame after the
welcome until it closes.

## The rate limit

One token bucket per (session, member) on the node, shared by the member's connections and
dropped with the last of them: `RELAY_SEQ_RATE` tokens a second up to `RELAY_SEQ_BURST`
(`rate-limit.ts`). A frame without a token is dropped, never queued, and the connection gets
`sys.slow_down {for_ms: 1000, reason: "rate"}` at most once a second. A member whose frames keep
being dropped for 5 s is closed **4429** after `sys.error frame_rate_exceeded`; one who stays
within the limit for the second it was asked to pause starts afresh. Acks and presence frames
are not limited here.

## The store

`SeqStore` (`types.ts`): `assign`, `head`, `range` (up to 1 000 frames after a seq) and `oldest`.

- **Redis** (`redis-store.ts`, production): one Lua script does the dedupe check, `INCR`,
  `XADD`, the trim and the dedupe record atomically. Keys, under the `ct:<env>:` prefix, with
  the session id as a Redis Cluster hash tag:

  | Key                                  | Holds                                                                  | TTL                          |
  | ------------------------------------ | ---------------------------------------------------------------------- | ---------------------------- |
  | `relay:ses:{sid}:seq`                | the counter                                                            | 31 days after the last frame |
  | `relay:ses:{sid}:buf`                | the hot buffer: a stream, entry id `<seq>-0`, field `f` the exact JSON | 48 h after the last frame    |
  | `relay:ses:{sid}:times`              | each buffered frame's receive time, in step with the buffer            | 48 h after the last frame    |
  | `relay:ses:{sid}:dedupe:{from}:{id}` | `<seq>\|<ts>`                                                          | 24 h                         |

  The module opens its own Redis connection (B009's backend is a key-value cache that exposes
  no generic script or stream commands) with the same rules: the prefix, 2 s command timeout,
  reconnects with backoff and jitter. It connects on the first sequenced frame, and a command cut
  off by a reconnect fails rather than running again later. An evicted script is reloaded; a
  counter lost while the buffer survived goes on after the newest buffered frame (`assign`,
  `head` and `oldest` alike); a lost times list is rebuilt (unknown ages count as now).

  The counter outlives a quiet session by 31 days (beyond any plan's 30-day `history_days`), so
  a live session never starts again at 1. A flush of everything a session had in Redis is B042's
  to recover (hydration from the durable log, and the pause around it); until B042 lands,
  numbering would restart at 1.

- **In memory** (`memory-store.ts`): the same rules step for step, for tests and tools. The
  relay never sequences without Redis: a second, local order would fork the session.

### Retention

At least `RELAY_BUF_MIN_FRAMES` frames or the frames of the last `RELAY_BUF_MIN_AGE_S`,
whichever is more, and never more than `RELAY_BUF_MAX_FRAMES` (`retention.ts`). After each
append the buffer is trimmed from the old end: first what is over the cap, then the frames older
than the age floor while more than the frame floor remain, at most 64 of those per append. The
buffer is always the contiguous run `oldest..head`, so `oldest() = head - size + 1`.

## Durable append

Each new frame is handed to the `DurableAppend` port after the buffer append, without waiting
(`durable.ts`; B042 wires B055's history store, until then the port keeps nothing). An append that
rejects, or has not settled within 10 s, counts `relay_durable_append_failed_total` and is retried
up to 5 times, 250 ms doubling to at most 10 s, each delay jittered between half and all of it;
then it is given up (`relay_durable_append_given_up_total`). At most 10 000 frames wait; past that
new ones are given up at once. Delivery never depends on the port.

## `ctx.seq`

`SeqService`:

- `store`: B042 replays from `range` and recovers lost sessions with `hydrate`, B044 gap-fills;
- `acks`: `onAck`, `lowestAcked(sid)`, for B046 and B042;
- `setDurableAppend(port)`: B042 wires B055's history writer;
- `delegateEcho(echo?)`: B044, see above. A resend's echo goes through `echo` when given (fan-out's
  `sendTo`, so a connection that is replaying holds it in order);
- `setReadiness(ready)`: B042's gate. Before a session's frame is assigned, `ready(sid)` must say
  the session may be sequenced (true at once for a known session; a promise while it is recovered
  from the durable log). A rejection refuses the frame with `service_unavailable` (sequencing
  paused for that session), never a `seq` from 1;
- `submitServerBatch(sid, frames)`: B049. Several server frames back to back (`SeqStore.assignBatch`:
  one MULTI/EXEC on Redis), so a kick and its `rotate_key` get consecutive `seq`s.
- `submitServer(sid, frame)`: B044's `emitServer`. A frame from `srv`, assigned in the session's
  `seq` space (deduplicated by its id), buffered and handed to the durable append.

`SeqStore.hydrate(sid, head, frames, now)` (B042): when the store's head is below `head` (a Redis
flush), the counter becomes `head` and the buffer holds exactly `frames` (the contiguous run ending
at `head`), atomically (`SEQ_HYDRATE_LUA`); otherwise nothing changes.

## Configuration

| Key                    | Default | Rule                            |
| ---------------------- | ------- | ------------------------------- |
| `RELAY_SEQ_RATE`       | `30`    | 1 to 10 000 frames a second     |
| `RELAY_SEQ_BURST`      | `100`   | 1 to 100 000                    |
| `RELAY_BUF_MIN_FRAMES` | `5000`  | 1 to 1 000 000, at most the cap |
| `RELAY_BUF_MIN_AGE_S`  | `600`   | 0 to 86 400                     |
| `RELAY_BUF_MAX_FRAMES` | `20000` | 1 to 1 000 000                  |

The handshake reads the rate and burst for `sys.welcome.limits` (`seq_rate`, `seq_burst`), so
clients are told what is enforced. An invalid value stops the relay at startup (ConfigError).
The Redis connection comes from `REDIS_URL` and `NODE_ENV` (the key prefix).

## Failure modes

- **Redis down or slow:** the frame is refused with `sys.error service_unavailable`
  (`retry_after_s` 1) and `sys.slow_down`, and so is every sequenced frame for the next second;
  the connection stays; nothing is sequenced locally. The client resends with the same `id`,
  which the dedupe makes safe.
- **A script error or timeout:** the same answer; the script is atomic, so nothing is half done.
- **A reply lost after Redis ran the script:** the sender got a 503 and resends; the resend is a
  duplicate, so it is echoed but not passed to fan-out again. Fan-out's gap fill (B044, from
  `range`) delivers that seq to the others.
- **The head cannot be read for an ack:** the ack is not recorded and the frame goes on.
- **The durable port fails or hangs:** retried and counted as above; the frame stays replayable
  from the hot buffer.
- **Redis lost the whole session (a flush):** see the store above; B042 recovers it.

## Observability

| Metric                                | Labels                                                             |
| ------------------------------------- | ------------------------------------------------------------------ |
| `relay_sequenced_total`               | `outcome`: assigned, duplicate, rate_limited, unavailable, backlog |
| `relay_seq_assign_ms` (histogram)     |                                                                    |
| `relay_acks_rejected_total`           |                                                                    |
| `relay_durable_append_failed_total`   |                                                                    |
| `relay_durable_append_given_up_total` |                                                                    |

Rate-limit closes are `relay_close_total{code="4429"}`. Log events, once per occurrence rather
than per frame where it repeats: `relay.seq_unavailable` (when the store first fails) and
`relay.seq_available` (when it answers again), `relay.seq_rate_closed`,
`relay.durable_append_gave_up` (`seq`, attempts, reason), `relay.seq_redis_error` and
`relay.seq_redis_ready`. Never `p`, `ct`, `sig`, ids or keys.

## Tests

`test/seq/`:

- **`seq.assign.test.ts`:** gapless, once-only seqs over random interleavings of five senders
  (fast-check); 1 000 frames from 5 SimClients on a running relay, observed in order by every
  client; server-stamped fields; the welcome's limits; `ctx.seq`; nothing kept after 300 clients.
- **`seq.dedupe.test.ts`:** resends (also after a reconnect on a running relay), the 24 h
  boundary on a fake clock, the same id from two members.
- **`seq.buffer.test.ts`** and **`buffer-suite.ts`:** retention, trimming, `range` and byte-exact
  frames; the suite also runs on Redis.
- **`seq.ack.test.ts`:** monotonic `acked_seq`, acks beyond the head, acks of other nodes'
  frames, acks that never queue, the invalid budget.
- **`seq.ratelimit.test.ts`:** 30/s and bursts of 100 without drops, `sys.slow_down`, 4429 after
  5 s, afresh after a pause, one bucket per member; on a running relay too.
- **`seq.backpressure.test.ts`:** the bound on waiting frames, the 1 s pause after a store
  failure, frames of a closed connection.
- **`seq.durable-port.test.ts`:** delivery while the port fails or hangs, retries, backlog, stop.
- **`seq.redis.integration.test.ts`:** on a real Redis (REDIS_URL or a container): 20 parallel
  clients, a raced id, keys and TTLs, NOSCRIPT, lost keys, the stage end to end; and with Redis
  down, 503s and the stage's answer.
- **`seq.perf.test.ts`:** `assign-bench.ts` in a child process: assign p95 under 2 ms at 1 000
  frames/s against Redis (best of 3 rounds).
- **`seq.frame.test.ts`**, **`seq.module.test.ts`:** the stored JSON (property test), wiring and
  configuration.

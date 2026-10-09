# Cross-node routing (B045)

Several relay nodes serve one session: each node publishes the frames it sequences and delivers
the others', so every client gets every frame once, in `seq` order, whichever node it is on
([CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Sequencing and delivery guarantees").
Supersede and member removal reach connections on every node. No contract defines inter-node
traffic; the envelope's ordering rules do. It is a relay module (`module.ts`, order 60) and sets
`ctx.cluster`.

## Parts

| File            | What it does                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `dispatcher.ts` | `ClusterDispatcher`: B044's `RemoteDispatcher` (publish), the receiver (into the ordered release), `reconcile`.  |
| `node.ts`       | `createClusterNode`: subscriptions and their grace, `MemberControl`, cross-node supersede, heartbeat, the sweep. |
| `channels.ts`   | Channel names, message shapes, defensive parsing, command checks.                                                |
| `config.ts`     | `RELAY_NODE_ID`, `RELAY_CLUSTER_GAP_MS`, `RELAY_UNSUB_GRACE_MS`, `RELAY_CLUSTER_RECONCILE_MS`.                   |
| `module.ts`     | Wiring: fan-out's dispatcher, the rooms' joins and leaves, `ctx.cluster`, shutdown.                              |

## Channels

All under the backend's `ct:<env>:` namespace. Messages are JSON and never logged.

| Channel                  | Message                         | What it carries                                                                 |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------- |
| `relay:{sid}:frames`     | `{node, sid, at, frame}`        | Each sequenced frame, exactly as B041 stored it (ciphertext opaque).            |
| `relay:{sid}:eph`        | `{node, sid, frame}`            | Ephemeral frames (presence, B047): local delivery only, never buffered.         |
| `relay:member:{mid}:ctl` | `{node, mid, cmd}`              | `cmd: {code, bye?, device?, before?, error?}`: close that member's connections. |
| `relay:node:{id}` (key)  | `{node, sessions, members, at}` | Heartbeat, 15 s TTL, refreshed every 5 s, for diagnostics.                      |

## Rules

- **Publish.** Fan-out hands each locally sequenced frame to the dispatcher, which publishes it. A
  failed publish is counted (`relay_cluster_publish_failed_total`). The frame is already in the
  hot buffer, so other nodes recover it.
- **Receive.**
  - A message from this node is ignored (own-node filter), and a malformed one is counted and
    dropped.
  - Any other frame goes into B044's `OrderedRelease`. The release reorders, drops what it
    already released (dedupe by `seq`), and asks for a missing range after
    `RELAY_CLUSTER_GAP_MS`. Fan-out then fills it from `SeqStore.range`, or closes the room 1001
    `resync` when the buffer no longer has it.
  - Pub/sub is lossy and unordered across publishers: nothing assumes delivery or order, and no
    `seq` is ever made up.
- **Where a session starts.** With frames from several nodes, the first to arrive need not be the
  lowest, so the release no longer starts at the first frame offered. B042's handshake hook primes
  it at the store's head + 1 for each connection, and the node pins the session (never forgotten
  as idle) while it is subscribed.
- **Subscriptions.**
  - A session's channels are subscribed when its room gets a first local connection. That happens
    in B043's join, after the handshake authorised the member.
  - They are left `RELAY_UNSUB_GRACE_MS` (30 s) after the last connection leaves, unless one
    joins again. After that the node receives nothing for the session.
  - A member's control channel is held the same way while the member has a connection here.
  - A failed subscribe is retried (100 ms doubling to 5 s, with jitter). Once it holds, the session
    is reconciled.
- **Reconcile.** Every `RELAY_CLUSTER_RECONCILE_MS` (5 s), each subscribed session's release is
  compared with the store's head, and missing frames are fetched and offered. This catches a lost
  last frame, and anything missed while pub/sub reconnected: ioredis resubscribes on its own, so
  no reconnect event exists to hook.
- **Member control.**
  - `ctx.cluster.memberControl.closeMember(mid, cmd)` closes the member's connections here at
    once, and on every other node through its control channel.
  - `device` limits a command to one device. `before` limits it to connections opened earlier,
    so the newest stays. `error` overrides the `sys.error` code and must match the close code.
  - After every welcome the handshake calls `ctx.cluster.welcomed`, which supersedes the same
    `(member, device)` on other nodes with `sys.bye superseded` and 4409.
  - Only server code calls `closeMember`. No client frame reaches a control channel.
- **Membership removal.** B043's `centcom:membership` listener runs on every node already, so a
  `removed` or `left` event closes the member everywhere. `closeMember` with 4403 is the same
  thing for session-level removal and B051's kick.
- **Ephemeral frames.**
  - `ctx.cluster.publishEphemeral(sid, frame)` sends one to the other nodes (for B047).
  - The receivers send it to their local connections as droppable.
  - It never touches the release, the hot buffer or the durable log.

## Config

| Key                          | Default       | Rule                                     |
| ---------------------------- | ------------- | ---------------------------------------- |
| `RELAY_NODE_ID`              | a random ULID | 1 to 64 of `A-Za-z0-9_-`                 |
| `RELAY_CLUSTER_GAP_MS`       | `250`         | 10 to 10 000 ms (the release's gap wait) |
| `RELAY_UNSUB_GRACE_MS`       | `30000`       | 0 to 600 000 ms                          |
| `RELAY_CLUSTER_RECONCILE_MS` | `5000`        | 0 (off) to 600 000 ms                    |

## Metrics

- `relay_cluster_published_total{channel}`, `relay_cluster_publish_failed_total{channel}`
- `relay_cluster_received_total{channel, result}`: `offered`, `delivered`, `applied`, `own`,
  `invalid`.
- `relay_cluster_lag_seconds`: a frame published by its node (`at`) to its arrival on another.
- `relay_cluster_subscriptions_total{kind, op}`: `session` or `member`; `subscribed`,
  `unsubscribed` or `failed`.
- `relay_cluster_reconciled_total`, `relay_cluster_reconcile_failed_total`
- `relay_cluster_control_closed_total`, `relay_cluster_heartbeat_failed_total`

## Limits

- **Room cap:** B043's room cap (`max_session_members`) is still counted per node. A session
  spread over nodes could pass it; a shared count is a follow-up.
- **Supersede and clock skew:** `before` compares the new connection's time on its node with older
  connections' times on theirs, so clock skew between nodes shifts it.
- **Priming window:** a frame from another node arriving between a connection's head read and the
  release's priming could start the session one frame late. The gap wait and the reconcile would
  not recover it, because the release would never ask for it. The window is one turn of the event
  loop.
- **Pub/sub throughput:** for very large sessions this is the card's noted risk. Redis Streams
  would be the next step if load tests show lag.

## Testing

`apps/relay/test/cluster/`:

- `cluster.order`: 3 nodes with random delays (3 runs); the own-node filter over 5 nodes; a
  fast-check property over any order, duplicates, echoes and losses.
- `cluster.gap-fill`: a dropped frame recovered within 250 + 50 ms; a lost last frame found by
  the reconcile; an unfillable gap resyncs 1001.
- `cluster.control`: supersede across nodes (4409, under 500 ms); closing a member everywhere
  (4403, under 1 s); the `before` and `device` filters; malformed commands.
- `cluster.subscription`: the lifecycle and grace, retries, the ephemeral channel, the heartbeat,
  the sweep.
- `cluster.failover`: node loss and resume on another node.
- `cluster.load`: 5 nodes at 500 frames/s, exactly once and in order; lag p95 under 20 ms in
  memory and on Redis 7.
- `cluster.units`: parsing, config, module wiring, and the seams in B042/B043/B044.

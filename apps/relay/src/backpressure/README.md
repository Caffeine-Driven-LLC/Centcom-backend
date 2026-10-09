# Backpressure (B046)

Protects the relay and healthy clients from slow consumers. The limit is 2 MiB of outbound buffer
per connection: past it, `sys.slow_down`, then close **4429** if the client does not catch up
([CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Limits"). A sequenced frame is never
dropped. It is a relay module (`module.ts`, order 55, no pipeline stage) and sets
`ctx.backpressure`.

## Parts

| File            | What it does                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `controller.ts` | `createBackpressure`: the per-connection policy, the grace, the sweep, the node guard, `whenDrained`. |
| `config.ts`     | `RELAY_OUT_BUF_BYTES`, `RELAY_OUT_BUF_SOFT_BYTES`, `RELAY_SLOW_GRACE_MS`, `RELAY_NODE_BUFFER_MAX`.    |
| `module.ts`     | Wiring: every connection's outbound policy, the `buffers` readiness check, `ctx.backpressure`.        |

## Rules

- **Accounting.** A connection's buffered bytes are its socket's `bufferedAmount`. Every relay
  send goes straight to the socket. B044's only queue is a replaying connection's hold, which is
  capped at 10 000 frames. A connection that cannot report its buffer counts as 0, logged once.
- **Where the rules apply.** B044's `ConnectionSender` asks the controller before every frame. That
  covers fan-out (sequenced), B042's replay (sequenced) and B045's ephemeral delivery
  (droppable). Decisions use sizes only.

  | Buffered (with the frame) | Droppable frame (presence, cursor) | Sequenced frame                                                                      |
  | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
  | ≤ 1 MiB (soft)            | sent                               | sent                                                                                 |
  | > 1 MiB                   | **dropped**, counted               | sent                                                                                 |
  | > 2 MiB (hard)            | dropped                            | sent; `sys.slow_down {for_ms: 2000, reason: "outbound"}` (≤ 1/s), grace starts (5 s) |

- **Grace.**
  - If the buffer is back under 1 MiB by the end of the grace, the connection has recovered.
    The 100 ms sweep notices it sooner.
  - If not, the client gets `sys.error slow_consumer` and is closed **4429**, 0-500 ms later.
    The jitter keeps a network event from closing everyone at once.
  - The client resumes with `last_seq` (B042) and loses nothing.
- **`sys.slow_down`** is written straight to the socket, not through the governed sender, and at
  most once a second per connection. Its `reason` is `outbound`, CT-WS-ENVELOPE's name; the card
  said `outbound_buffer`.
- **Replay.** `whenDrained(conn)` resolves once the connection is under the soft mark, or closed.
  B042's replay waits on it, so a replay never passes 2 MiB plus one frame.
- **Node guard.**
  - The sweep adds up every connection's buffered bytes. Over `RELAY_NODE_BUFFER_MAX` (1 GiB),
    the largest buffers are closed first (4429), until the rest is under 90 % of the cap.
  - While the total is over the cap, `/readyz` reports `checks.buffers.ok = false` and the relay
    refuses new connections (4503).
- **Timers.** A connection's grace and close timers are cleared when it closes. The sweep stops
  on shutdown.

### Every buffer and its cap (GUIDELINES §3.7)

| Buffer                                   | Cap                                             |
| ---------------------------------------- | ----------------------------------------------- |
| A connection's socket buffer             | 2 MiB, then 5 s to drain under 1 MiB, then 4429 |
| All connections' socket buffers together | `RELAY_NODE_BUFFER_MAX` (1 GiB)                 |
| A replaying connection's hold (B044)     | 10 000 frames, then 1001 `resync`               |
| A session's ordered release (B044)       | 2 000 waiting frames                            |

## Config

| Key                        | Default      | Rule                               |
| -------------------------- | ------------ | ---------------------------------- |
| `RELAY_OUT_BUF_BYTES`      | `2097152`    | 64 KiB to 256 MiB                  |
| `RELAY_OUT_BUF_SOFT_BYTES` | `1048576`    | 16 KiB to 256 MiB, below the limit |
| `RELAY_SLOW_GRACE_MS`      | `5000`       | 100 ms to 10 min                   |
| `RELAY_NODE_BUFFER_MAX`    | `1073741824` | 1 MiB to 64 GiB                    |

## Metrics

- `relay_outbound_buffer_bytes`: buffered bytes per non-empty connection, sampled every second.
- `relay_backpressure_slow_downs_total`, `relay_backpressure_graces_total`,
  `relay_backpressure_recovered_total`
- `relay_backpressure_closed_total{reason}`: `grace` or `node`.
- `relay_backpressure_dropped_total`

## Testing

`apps/relay/test/backpressure/`:

- `backpressure.watermarks`: thresholds, the grace, recovery, timers, `whenDrained`.
- `backpressure.ephemeral-drop`: droppable versus sequenced frames.
- `backpressure.slowdown-rate`: one per second.
- `backpressure.replay`: 5 000 frames to a slow reader; a real stalled client closed 4429 and
  resumed without loss.
- `backpressure.isolation`: healthy peers' p95 within 2x while one consumer is stalled.
- `backpressure.node-guard`: the global cap, largest first, `/readyz` and refused connections.
- `backpressure.module`: wiring and settings.

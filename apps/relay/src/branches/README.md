# Branch and conflict signalling (B061)

Relay-side handling of `branch.update` and `conflict.detected` (CT-WS-SESSION-EVENTS), so members
learn about branch divergence and overlapping work from metadata. The relay never sees branch
names, heads or paths: `branch.update` is encrypted-only, and `conflict.detected` carries agent ids
and path hashes in the clear.

## Interface

| Member                                      | What it does                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `BranchHandler.onBranchUpdate(ctx, frame)`  | Checks who sent it and that it carries `ct` only, and has it sequenced unchanged (`ct` never opened). |
| `ConflictSignal.onConflictDetected(ctx, f)` | Checks a member's signal (agents, path hashes, the 30 s window) and has it sequenced.                 |
| `ConflictSignal.onLockDenied(sid, d)`       | B059's denial: one server `conflict.detected` per pair of agents per 30 s, 10 per session per second. |
| `ctx.conflicts`                             | Set by the module; B059's locks module calls `onLockDenied` for every contested acquire.              |

## Rules

- **Who** (the catalogue's `editor*`): in a `command_post` session only the host sends either kind;
  in a `branch` session an editor may too (the owner of the agent, which the relay cannot check for
  `branch.update`: the agent is in `ct`). Viewers never (B043 refuses them first). Every session is
  a command post until sessions store a mode (as B057).
- **`branch.update`:** a cleartext `p` (even empty) or a missing `ct` is `invalid_frame` (B039's
  codec refuses both first, and a `ct` over 192 KiB). Every frame is sequenced and delivered in
  order: the relay never coalesces, drops or reorders them; B041's per-member rate limit applies.
- **`conflict.detected` from a member:** `p` must match the schema (at most 200 agent ids and 200
  path hashes); every agent must be one the session knows, owned by a member connected now (on any
  node), and not exited, else `invalid_frame` (a signed frame cannot be trimmed); every path hash
  has the lock store's hash shape (`^[A-Za-z0-9_-]{1,64}$`, as B059). It need not be locked now: a
  merge conflict can name files never locked (CT-WS-SESSION-EVENTS), and B059's lock keys go on
  release and expiry. An identical signal (the same agents and paths, in any order) within 30 s is
  refused `conflict`; the same frame sent again is acked again. A signal whose sequencing outcome
  is unknown (B041's store failed while assigning it) keeps its window.
- **From lock denials:** one `conflict.detected` from `srv` whose `p` names the holder's and the
  requester's agents and the one path hash, with no `ct`; once per pair of agents per 30 s (the
  window is checked before the registry is read, so a burst costs one Redis call each); at most
  10 per session per second (the rest counted and dropped, the pair not silenced). Unknown agents
  and agents whose owner is not connected are dropped; a signal left with fewer than two agents is
  not sent.
- **Failures:** registry or Redis down: a member's signal is `service_unavailable` (with
  `retry_after_s`), a server signal is dropped (counted); `branch.update` still passes. Nothing here
  holds any other frame.

## Storage (Redis)

- `conflict:<sid>:<hash>` (a member's signal) and `conflict:<sid>:pair:<hash>` (a server pair):
  `SET NX PX` 30 s; the key is a hash of the agent and path sets, the value the marking
  member/frame or `srv`.
- `conflict-signals:<sid>`: B009's sliding-window limiter (10 per second).

No key or value holds `ct`, a path hash or an agent id.

## Metrics

`relay_branch_updates_total`, `relay_conflicts_signalled_total{source}` (client, server),
`relay_conflict_signals_dropped_total{reason}` (duplicate, rate, ineligible, unavailable).

## Testing

`pnpm test` runs `apps/relay/test/branches/`: the handler (validation, `ct` byte-identical),
pass-through (no coalescing), conflict signals (agents, sizes, the 30 s windows, the rate cap,
dropped agents, failures), who may signal, privacy (logs and every Redis key and value scanned) and
the module (a contested lock through the pipeline becomes one server signal), over B009's in-memory
Redis with a fake clock.

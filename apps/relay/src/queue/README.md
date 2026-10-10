# Command-post queue (B052)

The relay-side queue of [CT-WS-QUEUE](../../../../contracts/04-session-events.md). It orders,
deduplicates, caps and approves queue items, applies the session's auto-approve policy (B051's
`control.policy`), and emits the authoritative `queue.state` after every change. It is a relay
module (`module.ts`, order 39 = `STAGE_ORDER.queue`: after authorisation, the privacy gate and the
control stage, right before sequencing) and sets `ctx.queue`.

## Parts

| File                 | What it does                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `state-machine.ts`   | `reduce`, `view`, `replay`: the pure, deterministic transitions, order and `queue.state`.   |
| `service.ts`         | `createQueueService`: caps, policy, the lock, save-then-sequence, auto-approval, host loss. |
| `policy-approver.ts` | `autoApproval`: `ask`, `trusted`, `everyone`, and the pause.                                |
| `stage.ts`           | The stage (39): queue frames to the service, an auto-approval as a companion frame.         |
| `store.ts`           | `QueueStore` in memory and on Postgres (`queue_session`, `queue_item`), locked per session. |
| `ports.ts`           | The ports: store, policy reader, sequencer.                                                 |
| `module.ts`          | Wiring, and the rooms' host-loss listener.                                                  |

## Rules

- **States** (CT-WS-QUEUE): `queued → approved → running → done | failed`, plus `canceled`,
  `rejected`, `dropped` and `held`.

  | Frame           | Who                         | From             | To                                     |
  | --------------- | --------------------------- | ---------------- | -------------------------------------- |
  | `queue.submit`  | host, editor                | none             | queued                                 |
  | `queue.approve` | host (or the relay, policy) | queued           | approved (held while the host is away) |
  | `queue.reject`  | host                        | queued           | rejected                               |
  | `queue.drop`    | host                        | queued, approved | dropped                                |
  | `queue.cancel`  | the submitter               | queued, approved | canceled                               |
  | `queue.claim`   | host                        | approved         | running (one item per agent; once)     |
  | `queue.done`    | host                        | running          | done, failed, canceled (by `outcome`)  |
  | `queue.reorder` | host                        | waiting items    | (their order)                          |

  Anything else is refused and nothing is sequenced:
  - an unknown or finished item: `queue_item_gone`;
  - a live item in the wrong state: `conflict`;
  - cancel by someone else, a second claim, or a busy agent: `forbidden` (audited).

  Roles come from B043 (live membership, every frame). A non-host's host-only frame is
  `forbidden` and audited there. A muted member's frames get `muted` (B051), also audited.

- **Order** comes only from approve (appends) and reorder frames, in `seq` order, never from
  timestamps.
  - A reorder puts the waiting items it lists first, in its order, and the rest keep their relative
    order after them; the later reorder wins.
  - Unknown ids are ignored, and the sender gets `queue_item_gone` once (all unknown: refused).
  - `position` (1-based) is the item's place among the ordered waiting items; a queued item never
    ordered has none.
- **Caps.** A member may have at most 5 live items (queued, approved, running, held). The
  session may have at most `queue_limit` (default 20); past either, `queue_full`. A submit whose
  `p.size` is over 192 KiB (196 608 bytes) is `invalid_frame` (`/p/size`). The relay never reads
  or stores `ct`.
- **Policy** (B051's store, read for every frame):
  - `locked`: every submit is `forbidden`, audited.
  - Auto-approval:
    - `ask`: never;
    - `trusted`: editors listed in `trusted`;
    - `everyone`: every editor;
    - never the host's own items.

    The relay's `queue.approve` comes from `srv` with `p: {item, reason: "policy", policy}`. It
    goes in the same batch as the submit (B041's companion frames): consecutive `seq`s, or neither.
    Its id is fixed by the item, so a retry dedupes.

  - Paused approvals (the policy's `queue_paused`, or the quota hook `setApprovalsPaused`):
    approve and claim are `queue_not_allowed` and nothing is auto-approved. Submit, cancel and drop
    still work.
- **Idempotency.**
  - The same frame again (same sid, from, id): B041 echoes its original `seq`.
  - The same item (`que_` id) from its submitter under a new frame id: the original submit is
    echoed, and nothing changes.
- **Version.** It rises by exactly 1 per accepted change (a frame, or the host leaving or coming
  back), never on a refusal. `queue.state` (`{version, items}`, items as QueueItemView) goes out
  after every change; a joiner gets the latest one (`lastState`, sent by the handshake after
  `welcome`).
- **Host loss.** When the host's last connection on a node closes, approved and running items
  become `held` (a new `queue.state` at once). When the host joins again, or after B051's
  `host_changed` (`onHostChanged`), they return. An item approved while the host is away is held.
  A frame from the host also ends the absence.

## Consistency

- **One writer per session.** The service takes the session's lock (`queue_session` row
  `FOR UPDATE`) and keeps it until the frame is sequenced and `queue.state` is out. So two nodes
  never change one queue at once, and versions follow `seq` order.
- **Save, then sequence.** The new queue is written before sequencing, so a failed write is
  `service_unavailable` and nothing is sequenced. A frame that is not sequenced rolls the
  transaction back. The final write records the frame's `seq`.
- **Restart.** A node loads the rows and replays the session's buffered frames sequenced after
  `updated_seq`. The `queue.state` frames it meets are checkpoints (version, held items). So a
  frame sequenced just before a crash is not lost, and the version continues without a gap.
- **Replay.** `replay(emptyQueue(), frames)` of every sequenced frame gives exactly the live
  `queue.state` (a property test checks it byte for byte).

## Stores

`queue_session` and `queue_item` (migration `20260102004000_queue_items.sql`) hold clear
metadata only: ids, submitter, state, position, size, kind, agent, timestamps and seqs. Both
cascade from their session.

## Metrics

- `relay_queue_items_total{state}`: items entering each state.
- `relay_queue_rejections_total{code}`: `queue_full`, `queue_item_gone`, `forbidden`, `conflict`,
  `invalid_frame`, `queue_not_allowed`, `service_unavailable`.

Logs carry the session, the kind, codes and versions.

## Limits

- **Host loss is seen per node.** A host connected through two nodes who closes one has their
  items held until their next frame or reconnect.
- **The quota pause is per node.** `setApprovalsPaused` is called on each node by B076.
- **A resend reaching another node** (after a reconnect) is checked again. A submit is still
  echoed; another kind may be answered `conflict` instead of echoed, and is never applied twice.
- **Catch-up** reaches only as far as B041's buffer.

## Testing

`apps/relay/test/queue/`:

- `queue.state-machine`: every op from every state, order, agents, host loss, version.
- `queue.caps`: per member, per session, size.
- `queue.idempotency`: resends, same item, concurrency, refusals, store and sequencer failures.
- `queue.replay-determinism`: last reorder wins, unknown ids, the 200-run replay property,
  restarts.
- `queue.policy`: `ask`, `trusted`, `everyone`, locked, roles, mutes, paused approvals.
- `queue.host-loss`: held and back, `host_changed`, approvals while away.
- `queue.contract`: every queue fixture, emitted frames schema-valid.
- `queue.postgres`: the store on Postgres 16, the lock, rollback, checks, cascade.
- `queue.module`: wiring.

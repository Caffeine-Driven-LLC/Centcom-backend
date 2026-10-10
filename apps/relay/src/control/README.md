# Session control (B051)

The relay enforces the host's authority actions: `control.kick`, `control.mute`,
`control.unmute`, `control.role`, `control.transfer_host`, `control.end` and `control.policy`
([CT-WS-CONTROL](../../../../contracts/04-session-events.md)). They are cleartext, sequenced
control frames, checked against live roles, applied atomically with the frames the relay emits
for them, and audited every time. It is a relay module (`module.ts`, order 38 =
`STAGE_ORDER.control`: after authorisation and the privacy gate, right before sequencing) and sets
`ctx.control`.

## Parts

| File               | What it does                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `stage.ts`         | The stage (38): routes client control kinds to the handler; frames of an ended session → 4404. |
| `handler.ts`       | `handleControlFrame`: checks, sequencing, effects, rollback, audit, resends.                   |
| `authority.ts`     | `checkAuthority`: the sender (host, read fresh) and the target rules.                          |
| `mute-registry.ts` | `MuteRegistry`: the mutes B043 reads (`isMuted`, `ready`), and `session_mute`.                 |
| `policy-store.ts`  | `PolicyStore` (`get`, `read`, `set`), `policyFrom`, the defaults, and `session_policy`.        |
| `ports.ts`         | The ports: membership, session state, sequencer, connections.                                  |
| `postgres.ts`      | The membership and session-state ports over `session_members` and `sessions`.                  |
| `connections.ts`   | Connected anywhere (Redis markers), closing members on every node (B045), cache refresh.       |
| `module.ts`        | Wiring, and B043's hooks (`setMuteState`, `setDeniedAuditor`).                                 |

## Rules

- **Who.** Only the host may send these kinds.
  - B043 (order 20) refuses anyone else from its 2 s role cache: `sys.error forbidden` to the
    sender only, nothing sequenced, one `control.<kind>` audit event (denied).
  - The handler then reads the sender's record again, without the cache. A host demoted a moment
    ago, on any node, is refused the same way: "the relay checks the sender's live role at
    sequencing time".
  - Server-only control kinds (`member_left`, `rotate_key`, `host_changed`, `session_state`, ...)
    from a client stay B043's `forbidden`.
- **Targets** (`p.member`, or `p.to`). The target must be a current member of the session
  (`not_found` otherwise) and not the sender (`conflict`). The host role goes only to an editor
  who is connected on some node (`conflict` otherwise). A mute's `until` must be in the future
  (`invalid_frame` at `/p/until`). A refused frame changes nothing and is not sequenced.
- **Order.** A frame is checked, then sequenced, then applied. Effects never come before the
  frame's `seq`, so they hold for frames with a higher `seq` (CT-WS-CONTROL "Ordering").
  - **`kick`:**
    1. the member is marked as left (`session_members.left_at`), so a reconnect is refused 4403
       (`not_a_member`);
    2. its connections close 4403 on every node (B045's member control);
    3. `control.member_left {member, code: kicked}` and `control.rotate_key {kid, reason:
member_removed}` go out from `srv` with consecutive `seq`s and nothing between them. That's
       B049's `rotate(sid, 'member_removed', {after})`: one Redis `MULTI`, whatever any node is
       sending.

    Closing comes before the pair, so nothing sequenced after the kick reaches the member. The
    relay only moves the epoch number; it never sees a key. A member already offline is still
    removed, and the pair still goes out.

  - **`mute` / `unmute`:** stored in `session_mute`. They apply on this node at once and on other
    nodes within 2 s. A muted member's `event` and `queue` frames get `sys.error muted`, while
    `presence` and `control` frames pass. A mute ends at `until` (the injected clock) or with
    `unmute`.
  - **`role`:** `session_members.role` is set, and this node's cached role is read again at once.
    The member's next frame is authorised with the new role here, and on other nodes within 2 s
    (CT-RBAC rule 2).
  - **`transfer_host`:** one transaction makes the host an editor and the editor the host. Then
    exactly one `control.host_changed {host, code: transfer}` goes out from `srv`.
  - **`end`:**
    1. the session becomes `ended` (`SessionStatePort`, with `ended_at`);
    2. `control.session_state {state: ended}` goes out;
    3. every member's connections close 1000;
    4. presence and the session's mutes are dropped.

    A frame on that session afterwards closes the connection 4404 (`session_ended`), and the
    handshake refuses new connections 4404.

  - **`policy`:** written to `session_policy` before sequencing, so a failed write refuses the
    frame and keeps the previous policy. Once the frame has its `seq`, that `seq` is recorded with
    the policy. `PolicyStore.get` reads the table every time, so the next frame (B052's queue, on
    any node) sees it.
    - Required fields replace the previous ones; optional fields left out keep their values.
    - `trusted` and `approvers` hold at most 50 `mem_` ids.
    - The codec (B039) has already refused a payload outside the generated schema; the handler
      checks again.

- **Atomicity and failure.**
  - The sequencer down when the frame arrives: B041's `service_unavailable`, nothing applied.
  - Follow-up frames that cannot be emitted undo the change, and the host gets
    `service_unavailable` (`retry_after_s` 1):
    - kick: the removal is undone, so the member, already closed, may reconnect;
    - transfer: the swap is reversed;
    - end: the state is put back and nothing closes.
  - A record that changed between the check and the effect (the member left) is `conflict`.
  - A policy whose sequencing failed is put back.
  - Records that cannot be read: `service_unavailable`, nothing sequenced.
- **Resends.** A resend of a frame this node accepted (same session, sender and id) has no second
  effect: B041 echoes its original `seq`.
- **Audit.** Every client control frame gets exactly one B036 event, accepted or refused:
  - action `control.<kind>`;
  - actor: the sender's user;
  - target: the member (`session_member`) or the session;
  - outcome: `success`, `denied` or `failed`;
  - meta: the action's allowlisted keys only (the session, enums such as `code` and `role`, a
    mute's `until`, a policy's field names). Never a payload value.

  Logs carry the session, the member, the kind and the outcome.

## Stores

- `session_policy` and `session_mute` (migration `20260102003900_session_control.sql`) cascade from
  their session, so the workspace purge (B027) takes them along.
- Key epochs stay in B049's Redis hash; the card's `session_epoch` table would be a second copy.
- `relay:ses:{sid}:on:{mid}` (Redis): one marker per member connected to a node. It is written on
  the member's first connection there, refreshed every 10 s, lives 30 s, and is deleted when the
  member's last connection there closes.

## Metrics

- `relay_control_frames_total{kind,outcome}`: `accepted`, `denied`, `rejected`, `failed`,
  `duplicate`.
- `relay_control_mute_loads_failed_total`

## Limits

- **Mutes and roles on other nodes** take up to 2 s, as CT-RBAC allows. Control frames themselves
  are always checked fresh.
- **Resends to another node** (after a reconnect) are checked again. A kick resent after it
  applied is then `not_found`, and is still not applied twice.
- **"Connected"** can lag a member who moves nodes by up to 10 s, so a transfer may be refused
  once. A crashed node's markers expire in 30 s.
- **An effect that fails after sequencing** leaves the sequenced frame in the log. Kick, transfer
  and end roll back, as above; a failed mute or role write is reported to the host
  (`service_unavailable`) for a retry.
- **Frames the codec refuses** (outside the schema) never reach the handler and are not audited
  (B039 counts them).

## Testing

`apps/relay/test/control/`:

- `control.authority`: the role matrix, the fresh re-read, concurrent changes, targets, `role`.
- `control.kick-rotate`: 4403 in under 500 ms, the adjacent pair under 50 concurrent frames and as
  a fast-check property, reconnects, failures, offline targets, resends.
- `control.mute`: refusal rules, presence, expiry on an injected clock, other nodes, store
  failures.
- `control.transfer-end`: the single `host_changed`, invalid targets, rollback, end and 4404.
- `control.policy`: invalid payloads, visibility before the next frame, failures.
- `control.contract`: every control fixture through the handler, emitted frames schema-valid.
- `control.audit`: 50 accepted + 50 refused = 100 events, B036's emitter, no payload text.
- `control.postgres`: the stores and ports on Postgres 16, and the purge cascade.
- `control.module`: wiring.

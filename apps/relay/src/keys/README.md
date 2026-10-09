# Key grants and epochs (B049)

Routes `key.grant` events to the right devices without opening them, enforces each frame's key
epoch (`ct.kid`), and signals new epochs with `control.rotate_key`, so removed members can't read
new frames ([CT-CRYPTO](../../../../contracts/05-crypto.md) §4-5,
[CT-WS-SESSION-EVENTS](../../../../contracts/04-session-events.md)). The relay never chooses,
holds or sees a key. It is a relay module (`module.ts`, order 25 = `STAGE_ORDER.keys`, plus a stage
at 41 = `STAGE_ORDER.rotate`) and sets `ctx.epoch`.

## Parts

| File             | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `stage.ts`       | Validation (25): grants and `ct.kid`. Rotation (41): a newly sequenced `control.rotate_request`. |
| `epochs.ts`      | `createEpochs`: the tracker (`current`, `advance`, `due`), the signal (`rotate`), the kid check. |
| `epoch-store.ts` | `relay:ses:{sid}:epoch` on Redis (and in memory): the counter, the current epoch, rotation seqs. |
| `validate.ts`    | `validateKeyGrant`: role, `to_device`, `kids`.                                                   |
| `devices.ts`     | Whether a device belongs to a current member of the session (Postgres).                          |
| `module.ts`      | Wiring.                                                                                          |

## Rules

- **Grants** (`key.grant`, hybrid), at order 25 before sequencing:
  - the sender is a host or an editor;
  - `p.to_device` is a device, not revoked, of a current member of the session;
  - `p.kids` holds 1 to 200 entries, each `k<n>` with n from 1, none above the current epoch + 1.
    A grant may carry the next epoch's key just before its rotation.

  A grant that breaks a rule gets `sys.error forbidden` or `invalid_frame` (with the field's
  pointer) and is not sequenced. A valid one is sequenced and delivered to every member like any
  frame, so `seq` stays contiguous; only `to_device` can open the sealed boxes. `ct` and `sig` are
  carried byte-identical and never logged. Granting does not advance the epoch.

- **Kids.** Every sequenced frame with a `ct` has its `ct.kid` checked against the session's epoch:
  - a kid that is not `k<n>` is refused;
  - one newer than the current epoch is refused;
  - one older than the current epoch is refused only once that connection has acked the `seq` of
    the rotation that superseded it. Until then it is in flight, and accepted.

  A refusal is `invalid_frame` at `/ct/kid`, and the frame is not sequenced. Before refusing, the
  store is read again, in case another node rotated. Otherwise a session's epoch is cached on the
  node for 5 s.

- **Rotation.** `ctx.epoch.rotate(sid, reason, {after?})` does the following:
  - takes the next epoch number from the store's counter (atomic, never reused);
  - emits `control.rotate_key {kid, reason}` from `srv` through B044, sequenced and delivered in
    order;
  - records it as current, with its `seq`.

  Reasons are `member_removed`, `scheduled` and `requested`; anything else throws. With `after` (for
  B051's `control.kick`), the two frames are sequenced back to back through one Redis `MULTI`
  (B041's `assignBatch`). Their `seq`s are consecutive whatever else any node is sending
  (CT-WS-CONTROL).

- **`control.rotate_request`.** B043 lets only a host send it. Once B041 has sequenced it, the
  relay emits one `rotate_key` for the next epoch. A resend of the same id is a duplicate and
  emits nothing. A client's `control.rotate_key` is refused by B043 and can never move the epoch.
- **Due.** `ctx.epoch.due(sid)` reports `scheduled` once an epoch is 7 days old or 100 000 frames
  long, and counts it once. The relay never rotates by itself: the host decides.
- **Fail closed.** If the epoch store or the device lookup fails, grants and encrypted frames get
  `service_unavailable` (`retry_after_s` 1), never let through unchecked. The connection stays.

## Epoch store

`relay:ses:{sid}:epoch` is a hash that lives 31 days after the last rotation, so it survives relay
restarts. Its fields:

- `n`: the counter;
- `kid`: the current epoch;
- `started_at`;
- `seq`: the announcing `rotate_key`;
- `r<e>`: the rotation `seq` into each epoch.

A session never rotated has no key and is at `k1`. "Frames since rotation" is the session's head
minus `seq`, so no write per frame.

## Metrics

- `relay_key_grants_total{result}`: `routed`, `forbidden`, `invalid_frame`.
- `relay_kid_refused_total{reason}`: `invalid`, `future`, `stale`.
- `relay_epoch_rotations_total{reason}`, `relay_epoch_rotate_failed_total`
- `relay_epoch_rotation_due_total`, `relay_key_checks_unavailable_total`

## Limits

- **Ack is per connection.** A member with two devices is checked per device: each connection's
  own ack.
- **Node cache lag.** A node's cached epoch can be up to 5 s behind a rotation done elsewhere.
  It is never behind when refusing (the store is re-read first), but it may accept a stale-kid
  frame from a member who already acked a rotation another node made, within those 5 s.
- **Signatures are not verified** here (optional abuse filter, out of v1 scope).

## Testing

`apps/relay/test/keys/`:

- `keys.grant-validation`: role, target device, kids rules, the contract fixture, a failing lookup.
- `keys.epoch`: rotate, reasons, restart, `advance`, `rotate_request` and resends, Redis.
- `keys.rotate-adjacency`: kick + `rotate_key` adjacent under a flood, in memory and on Redis 7.
- `keys.stale-kid`: ack-based enforcement, in-flight tolerance, future kids, fail closed.
- `keys.opaque`: canary bytes never logged, forwarded unchanged.
- `keys.due`: the 7 days and 100 000 frames triggers.
- `keys.module`: wiring.

# Reactions and comments persistence (B062)

Reactions (cleartext) and comments (ciphertext) as queryable records, so late joiners and the
history can show them, without the relay reading comment text.

## Interface

| Member                                         | What it does                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ReactionStore.apply(sid, {seq, from, ...})`   | Applies a sequenced reaction for its sender; `{changed}` when the live set changed.                    |
| `ReactionStore.aggregate(sid, targets)`        | The live reactions of those frames, counted per code (`ctx.reactions.reactionsFor` for the join flow). |
| `ReactionStore.rebuild(sid, ops)`              | Re-applies reactions from the log (the repair after failed writes; idempotent).                        |
| `CommentIndex.record(sid, {seq, id, ...})`     | Records a sequenced comment's pointer: seq, frame id, sender, `ct` size, key id.                       |
| `purge(sid)` (both, and `ctx.reactions.purge`) | Removes a session's rows (B055's history purge).                                                       |

## Rules

- **Who:** host, editor and viewer may send both kinds (CT-RBAC); B043 refuses a muted member's
  frames before this stage, with `muted`.
- **`reaction`:** `target` a frame id (`msg_`), `code` one of `thumbs`, `heart`, `party`, `laugh`,
  `eyes`, `check`, `op` add or remove, else `invalid_frame` (B039's codec refuses them first); at
  most 200 per member per minute, else `rate_limited`. A member holds at most one reaction per
  code on a target, so at most 6, inside the contract's 20.
- **`comment.add`:** encrypted only (its target and text are in `ct`); a `p` or a missing `ct` is
  `invalid_frame`; `ct` at most 192 KiB (the codec).
- **State from sequenced frames only:** after a frame is sequenced, the reaction is applied for its
  sender (never another member's), the comment's pointer recorded, in the background (delivery
  never waits for Postgres). A reaction applies only when its seq is newer than the row's: add twice
  is one row, remove drops it from the live set (the row stays as a tombstone at its seq), a remove
  of a missing reaction changes nothing, a replay changes nothing, and frames applied out of order
  end in the state of the highest seq.
- **Failures:** a failed write is counted (`relay_reaction_writes_failed_total{kind}`) and logged;
  the frame stays in the log, and `rebuild` re-applies the log's reactions. A target the history
  does not have is stored anyway.

## Storage (Postgres, migration `20260102005400_reactions_comments.sql`)

- `reaction(session_id, target, code, member_id, seq, removed, updated_at)`, primary key
  `(session_id, target, code, member_id)`.
- `comment_ref(session_id, seq, msg_id, member_id, size, kid, created_at)`, primary key
  `(session_id, seq)`, unique `(session_id, member_id, msg_id)`. No text and no target column.

Both cascade from their session.

## Testing

`pnpm test` runs `apps/relay/test/reactions/`: apply (idempotency, toggling, order, other members,
rebuild), aggregate (50 targets x 6 codes x 20 members, counts and the 50 ms bound), comments (the
schema has no text column, replay, the stage records pointers only), purge, authorisation, and the
contract and stage (codes, targets, replay, the rate limit, failed writes). The Postgres tests run
on B010's stack (DATABASE_URL, or a container runtime).

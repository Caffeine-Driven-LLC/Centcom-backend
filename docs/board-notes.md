# Shared board notes in the relay (B111)

Frames: `board.note` (hybrid: `type` and `supersedes` clear, `text` and `refs` encrypted), `board.pin` and `board.remove` (clear; they name the note in `target`, never `note`: the privacy stage strips a clear `note` from every kind because that is the name of encrypted free text). The id of a note is the `msg_` id of its `board.note` frame.

| Role   | Add | Pin            | Remove |
| ------ | --- | -------------- | ------ |
| host   | yes | yes            | any    |
| editor | yes | yes (any note) | own    |
| viewer | no  | no             | no     |

Rules (`apps/relay/src/board/service.ts`): a pin or remove must name a live note of the session (`invalid_frame` otherwise); a removed note cannot be pinned or removed again; `supersedes` must name a live note by the same author (the host may replace any) and retires it; 20 notes per member per hour and 500 live notes per session, over which the relay answers `frame_rate_exceeded` and does not sequence; a resend of a note by its author is sequenced again and changes nothing. Refusals consume no sequence number.

State: one Redis document per session (`relay:board:<sid>`, 48 h after its last change, under a mutex) with each note's id, author, type, pinned and removed flags. Never text or refs. A lost document starts over (the notes stay in the sequenced history, and a pin or remove of a note the relay no longer knows is refused `invalid_frame`).

Not done: deleting the document when a session's history is purged (it expires on its own), and replaying removal to a late joiner beyond what history carries (removal is a display rule: the removed note's frame is ciphertext and stays in history).

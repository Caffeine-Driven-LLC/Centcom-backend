# Envelope codec (B039)

Every inbound WebSocket message passes the decode stage first (`module.ts`, pipeline order 10).
It turns the message into a frame later stages can trust
([CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md), CT-WS-SESSION-EVENTS).

## `decodeFrame(raw, isBinary, sid)`

The checks run in this order, and the size check comes before anything is parsed:

1. Binary messages are refused (`invalid_frame`), and so is anything over 256 KiB
   (`frame_too_large`).
2. Bytes must be UTF-8, and JSON may nest at most 16 levels (counted on the text, frame included).
3. Unknown top-level fields are dropped, and `from`, `ts` and `seq` are removed: only the server
   sets them.
4. The frame must pass the generated validators: `envelope.schema.json`, then
   `events.schema.json`, which checks each kind's clear, encrypted or hybrid mode. An unknown kind
   under a known `t` passes untouched; an unknown `t` fails.
5. `ct` may be at most 192 KiB serialised and `queue.submit.p.size` at most 192 KiB
   (`frame_too_large`). `sid` must be the connection's session.

A refusal names the field by JSON pointer and never echoes a value. `ct` is measured, never
parsed or logged. `decodeFrame` never throws.

`encodeFrame(frame)` writes the envelope's fields only, in the order
`v,t,id,sid,from,ts,seq,ack,ref,k,p,ct,sig`. `FRAME_LIMITS` holds the limits.

## The stage

- **A binary message:** `sys.error` `invalid_frame`, then close **4400**.
- **Over 256 KiB:** `sys.error` `frame_too_large` (413); the frame is dropped.
- **Before the handshake (B038) authenticates the connection:** only those two transport checks
  apply. The handshake owns `sys.hello`, with its own answers (4401, 4400).
- **After authentication:** the frame is decoded with the connection's session. A failure gets
  `sys.error` (`invalid_frame` or `frame_too_large`, with the pointer in `errors[]`) and is
  dropped; a success is set on `fc.frame` for the later stages.
- **Budget:** invalid frames are counted per connection, and the 11th within 60 s closes it
  with **4400**.
- **A decoder exception:** the frame is dropped, `relay_codec_errors_total` is counted, and the
  connection stays open.

Metrics: `relay_frames_invalid_total{code}` and `relay_codec_errors_total`.

## Tests

`apps/relay/test/codec/`: `codec` (limits, fixtures, mode flips, unknown kinds and types, a
property over 1 000 frames, 100 000 fuzz inputs, and the timing bench `decode-bench.ts` in a child
process) and `stage` (the socket behaviour, the budget on a fake clock).

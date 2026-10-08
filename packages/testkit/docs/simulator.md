# Mock client simulator (B011)

Scripted fake clients that speak the relay's WebSocket protocol (CT-WS-ENVELOPE, CT-RESUME), so
relay lanes are built and tested without a real client. Import it from `@centcom/testkit/sim`;
the package root exports none of it. Test-only.

```ts
import { mintTestTicket, SimClient, testJwks } from '@centcom/testkit/sim';

// The relay under test trusts the test keys: configure it with testJwks().
const host = await SimClient.connect({
  url: `ws://127.0.0.1:${port}/v1/ws`,
  ticket: () => mintTestTicket({ sid, mid, dev, role: 'host' }), // a fresh ticket per connect
  lastSeq: 0,
});
const { id, seq } = await host.send('reaction', { target, code: 'thumbs', op: 'add' });
const echo = await host.waitFor((f) => f.id === id);
await host.close();
```

## What a SimClient does

| Behaviour     | Detail                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handshake     | Opens the socket with subprotocol `centcom.v1`, sends `sys.hello` at once (ticket, `protocols` `[1]`, `caps` `['resume']`, `last_seq`), waits for `sys.welcome` (`welcome`) |
| Heartbeat     | Answers `sys.ping` with `sys.pong` of the same `t`; drops a relay that is silent for `dead_ms` (50 s)                                                                       |
| Sequencing    | Processes sequenced frames once each, in `seq` order; frames after a gap wait (`wire` has everything, `frames` what was processed)                                          |
| Ack           | Sends `ack` with the highest contiguous seq after every 64 frames and within 5 s of an unacked frame; `ack()` sends one now                                                 |
| Sends         | `send(kind, p?, {ct?, type?})` builds a frame with a fresh `msg_` id and resolves with `{id, seq}` when the echo arrives; encrypted kinds get opaque `ct` and a dummy `sig` |
| Resume        | `reconnect()` sends `last_seq` = `lastSeq` and, as the welcome arrives, resends unacked frames with the same ids                                                            |
| Closes        | Never reconnects by itself unless `autoReconnect` (250 ms × 2ⁿ, full jitter, cap 15 s); never after 4401/4403/4404/4409/4426 or a third 4400 in 60 s                        |
| Unknown input | Unknown types or kinds and unparseable frames are logged through `onDebug`, and sequenced ones still advance and get acked                                                  |
| Bounds        | Every wait times out (5 s by default, real time even on a manual clock); `frames`, `wire` and `sent` keep the newest 10 000 entries                                         |
| Debug mode    | On by default: every frame written is validated against the envelope schema, and a send that does not validate rejects with `FrameError`                                    |

The client never sets `from`, `ts` or `seq`. A fault scenario that checks the server ignores
them uses `sendFrame(frame, { allowServerFields: true })`.

Ciphertext is random bytes under key id `k1` and signatures are random bytes too. Nothing is
encrypted or signed: the simulator is not a crypto reference (CT-CRYPTO is the client's).

## Tickets

`mintTestTicket({sid, mid, role, dev?, ttlS?, caps?})` signs a relay ticket as CT-AUTH describes:
EdDSA (Ed25519), `aud` `centcom-relay`, 60 s, a random `jti`, claims `sid`, `mid`, `role`, `dev`
(left out for a share-link guest) and `caps`. The key pair is made per process; its key id starts
with `test-`. `testJwks()` returns the public key, which is what the relay under test must trust,
so these tickets can never validate against a production JWKS. `verifyTestTicket()` checks a
ticket the way a relay must (signature, `test-` key id, audience, expiry, claim shapes).

## Faults

Inbound faults sit between the socket and the protocol layer, outermost first:
`SimClient.connect({ faults: [faults.duplicate(1), faults.reorder(4)] })`.

| Fault                           | Effect                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `faults.drop(p)`                | Loses each frame with probability `p`                                                     |
| `faults.duplicate(p)`           | Delivers each frame twice with probability `p`                                            |
| `faults.delay(ms)`              | Delivers each frame `ms` later on the client's clock                                      |
| `faults.reorder(window)`        | Shuffles each `window` frames (a partial window goes out after 20 ms)                     |
| `faults.disconnectAfter(n, c)`  | Ends the connection after `n` frames: 1006 drops it, any other code closes it. Fires once |
| any `(data, next, ctx) => void` | A custom fault: pass the frame on with `next` zero or more times                          |

Pass a seeded `random` to make the probabilistic ones repeat. Outbound faults are methods:
`sendRaw(text)` (malformed JSON, oversize frames), `connect({ sendHello: false })` (no hello),
`stall()`/`unstall()` (stop reading the socket), `terminate()` (a network drop, 1006), and
`sendFrame(..., { allowServerFields: true })`.

## Fleets and scenarios

`SimFleet.spawn(n, (i) => opts)` connects 1 to 50 clients at once. If one fails, the others are
closed and the error is rethrown. `waitForAll(pred)` and `closeAll()` act on all of them.

```ts
const run = await scenario()
  .connect('host') // the first client is the host, the rest are editors
  .connect('guest', { role: 'viewer' })
  .send('host', 'reaction', { target, code: 'thumbs', op: 'add' }, { label: 'thumbs' })
  .expect('guest', (f) => f.k === 'reaction')
  .step('check', (ctx) => expect(ctx.client('guest').lastSeq).toBe(1))
  .run();
```

Without `url`, a run starts a LoopbackRelay and stops it afterwards. Every step is bounded by
`timeoutMs`. A failing step throws `ScenarioError` naming the step's number and label. All
clients are closed at the end, pass or fail.

## Time

Pass `clock: createManualClock()` to both sides to drive heartbeats, the ack cadence and the
hello timeout without waiting: `clock.advance(5_000)`. Waits for frames still use real time.

## LoopbackRelay

An in-process reference server, used only to test the simulator. It does the handshake (4408
after 5 s without hello, 4426 for no common protocol, 4401 for a bad or replayed ticket), pings,
validates every frame (`sys.error` `invalid_frame`; more than 10 in a minute close 4400), enforces
the 256 KiB frame limit, assigns `seq` per session and echoes to the sender, de-duplicates by
(sid, from, id), replays after `last_seq` with `sys.resumed` (and `history_gap`), and supersedes a
device's earlier connection (4409). It has no authorization, rate limits or durable history: it
is not the relay (B037 on). Point a SimClient at the real relay with
`ws://localhost:<port>/v1/ws` instead.

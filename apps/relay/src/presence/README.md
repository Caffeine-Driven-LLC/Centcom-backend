# Presence (B047)

Ephemeral presence per member. The relay keeps each member's latest `presence.update`, fans it out
at most once per 500 ms, sends a joiner one frame per member right after `welcome`, and derives
online/offline from the connection with a 10 s grace
([CT-WS-PRESENCE](../../../../contracts/04-session-events.md)). Presence is never sequenced,
buffered, replayed or stored durably, and no feature may depend on it arriving. It is a relay
module (`module.ts`, order 35 = `STAGE_ORDER.presence`) and sets `ctx.presence`.

## Parts

| File          | What it does                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- |
| `stage.ts`    | The stage (35): checks `presence.update`, stamps the connection's member, hands it on.   |
| `service.ts`  | `createPresence`: limits and coalescing, fan-out, snapshot, online/offline, session end. |
| `store.ts`    | `presence:{sid}` hashes on Redis (60 s TTL), in memory, and the fallback between them.   |
| `validate.ts` | `checkPresenceUpdate`: the enums, `agent_count`, and nothing else kept.                  |
| `config.ts`   | `RELAY_PRESENCE_IN_MS`, `RELAY_PRESENCE_OUT_MS`, `RELAY_OFFLINE_GRACE_MS`.               |
| `module.ts`   | Wiring: the store, rooms' joins and leaves, B045's ephemeral channel, `ctx.presence`.    |

## Rules

- **In** (order 35, after authorisation: every role may send `presence.update`).
  - `p.status` must be `online`, `away` or `busy`, and `p.activity` must be `idle`, `typing`,
    `reviewing` or `running`. `p.agent_count` is optional: a whole number from 0 to 1 000.
  - Anything else is `sys.error invalid_frame` with the field's pointer, and changes nothing.
    Other fields of `p` are dropped.
  - A client's `from` is never read: the connection's member is stamped.
  - The frame goes no further, so it is never sequenced. `presence.cursor` and `presence.nudge`
    pass on to B048.
- **Limits per member.**
  - An update goes out at once if the member's last one went out at least
    `RELAY_PRESENCE_OUT_MS` (500 ms) and `RELAY_PRESENCE_IN_MS` (1 s) ago.
  - Otherwise it replaces the pending value, with no error and nothing queued. The latest value
    goes out as soon as both limits allow.
  - With the defaults that is at most once a second, and the final value always goes out.
- **Out:** `{v, t: "presence", sid, from, ts, k: "presence.update", p}`, with no `id` and no
  `seq`. Each value is:
  - written to the store;
  - sent to every welcomed connection of the session on this node, as droppable (B046 drops it
    first);
  - published to the other nodes on B045's `relay:{sid}:eph`, whose receivers hand it to this
    service.

  The member's own connections get it too; clients ignore their own presence.

- **Snapshot:**
  - Right after a connection's welcome, it gets one frame per member that has a presence. The
    snapshot reads the store, so it includes other nodes' members. This node's value wins when
    it is newer than the stored one.
  - Live presence for that connection waits until the snapshot has gone, then the latest value
    per member that came meanwhile follows.
  - Nothing reaches a connection before its welcome.
- **Online/offline**, from the connection only: a member is online while it has a connection
  here, and for `RELAY_OFFLINE_GRACE_MS` (10 s) after its last one closed. A reconnect inside the
  grace keeps it online. When the grace ends, the member's state goes, and so does its stored entry
  if this node wrote it.
- **Store:** `presence:{sid}` is a Redis hash with one field per member (`{p, at, node}`).
  - The key's TTL is 60 s, refreshed on every write, so a crashed node or an ended session leaves
    nothing behind.
  - An entry older than 60 s is never read, even while other members keep the key alive.
  - When Redis fails, node-local memory takes over for that call (logged once, counted).
    Sequenced traffic never depends on it.
- **Bounds:** one entry per member, at most 50 members per session. A flood is overwritten in
  place. `endSession(sid)` drops a session's state and stored presence; B053 calls it.

## Config

| Key                      | Default | Rule            |
| ------------------------ | ------- | --------------- |
| `RELAY_PRESENCE_IN_MS`   | `1000`  | 0 to 60 000 ms  |
| `RELAY_PRESENCE_OUT_MS`  | `500`   | 0 to 60 000 ms  |
| `RELAY_OFFLINE_GRACE_MS` | `10000` | 0 to 600 000 ms |

The store uses `REDIS_URL` under the environment's key prefix, on its own connection.

## Metrics

- `relay_presence_updates_total{result}`: `accepted`, `coalesced`, `invalid`, `over_cap`.
- `relay_presence_fanouts_total`, `relay_presence_snapshots_total`,
  `relay_presence_offline_total`
- `relay_presence_delivered_total{result}`: `queued`, `dropped`, `closed`, `error`.
- `relay_presence_store_failed_total`

Logs carry sessions and counts, never a payload.

## Limits

- **Online is per node.** `isOnline` sees this node's connections only. A member whose devices
  are on two nodes is online on each separately.
- **Stored entries after an offline.** When a member goes offline here, the stored entry goes
  only if this node wrote it; another node's newer one stays. A member who left elsewhere can
  show in snapshots until its entry is 60 s old.
- **Typing auto-clear and cursors** are B048's (`onUpdate` lets it watch each update).

## Testing

`apps/relay/test/presence/`:

- `presence.coalesce`: 10 updates a second; a fast-check property over any timing; the 10 % CPU
  benchmark (1 000 members, 20 sessions).
- `presence.snapshot`: order after the welcome, held live frames, newer local values, across
  nodes, on a running relay.
- `presence.not-sequenced`: `head`, the hot buffer, the durable log and replay untouched.
- `presence.offline-grace`: reconnects inside and outside the grace, session end.
- `presence.ttl`: expiry in memory and on Redis 7, and the fallback.
- `presence.validation`: enums, unknown fields, roles, `from`.
- `presence.module`: wiring and settings.

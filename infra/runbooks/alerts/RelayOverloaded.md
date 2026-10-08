# RelayOverloaded

Severity: `ticket` · Service: `relay` · Owner: `realtime` · Rules:
[relay.rules.yaml](../../alerts/rules/relay.rules.yaml)

## Symptoms

Over 1 % of the connections closing in a region closed with code 4503 (overloaded) for 5 minutes.
The relay closes a new connection with 4503 when it already holds `RELAY_MAX_CONNECTIONS` (B037,
default 20 000 per relay) or while it is not ready (Redis or the database unreachable), sheds
connections at its buffer limits (B046), and refuses handshakes while it cannot verify tickets
(B038). It does not log these closes one by one: the metrics are the record.

## Impact

Clients are pushed off a full relay and reconnect, usually to another one; customers see brief
"reconnecting" banners. It pages only through [RelayConnectBurn](RelayConnectBurn.md) and
[ResumeFailureBurn](ResumeFailureBurn.md) when reconnects start failing.

## Dashboards

- `$GRAFANA/d/centcom-relay-overview?var-env=$ENV`: "Closes by code", "Open connections by region",
  "Outbound buffer p95 (B046)", "Upgrades refused".

## Triage commands

1. Where (Grafana Explore):
   `sum by (region) (rate(centcom_relay_close_total{env="$ENV", code="4503"}[5m]))`.
2. Are relays at the connection cap: `sum by (region) (centcom_relay_connections{env="$ENV"})` against
   `RELAY_MAX_CONNECTIONS` times the machine count in `fly status -a centcom-$ENV-relay`.
3. Is a relay not ready (then every new connection gets 4503): ask each machine directly, past the
   load balancer, `curl -sS -H "fly-force-instance-id: <machine id>" "$RELAY/readyz"`; `checks`
   names the failing dependency.
4. Is it buffers (slow consumers), once B046 emits the histogram:
   `histogram_quantile(0.95, sum by (le) (rate(centcom_relay_outbound_buffer_bytes_bucket{env="$ENV"}[5m])))`.
5. Is it ticket verification: `curl -sS "$API/.well-known/jwks.json"` answers 200.

## Mitigation

- At the cap: add a relay in that region, `fly scale count <n + 1> -a centcom-$ENV-relay --region <region>`.
- Not ready: fix the dependency ([RedisMemoryHigh](RedisMemoryHigh.md),
  [ReadyzFailing](ReadyzFailing.md)); adding relays does not help.
- JWKS unreachable: fix the API ([ApiAvailabilityFastBurn](ApiAvailabilityFastBurn.md)).
- One misbehaving machine: `fly machine restart <machine id> -a centcom-$ENV-relay` (clients
  reconnect elsewhere).

## Escalation

A ticket for the realtime team during working hours. If customers report failed joins, check
whether RelayConnectBurn is firing; it pages on its own.

## Verification

`sum by (region) (rate(centcom_relay_close_total{env="$ENV", code="4503"}[5m]))` back near 0, and the
alert resolves (`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=RelayOverloaded env=$ENV`).

## Post-incident

Record peak connections per relay; if the cap was hit by organic growth, file a capacity change
(machine count or size in B091's Fly config) with the realtime team.

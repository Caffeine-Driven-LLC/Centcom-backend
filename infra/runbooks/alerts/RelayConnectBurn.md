# RelayConnectBurn

Severity: `page` (14.4x over 1 h and 5 m, or 6x over 6 h and 30 m), `ticket` (3x over 3 d) ·
Service: `relay` · Owner: `realtime` · SLO: `relay-connect` (99.5 % of handshakes succeed within
2 s) · Rules: [relay.rules.yaml](../../alerts/rules/relay.rules.yaml)

## Symptoms

Relay handshakes (hello to welcome) fail or take over 2 s: 7.2 % or more over an hour (fast), 3 %
or more over 6 hours (slow), or 1.5 % or more over 3 days (ticket). Customers report sessions that
will not open or join, and the client showing "reconnecting".

## Impact

New sessions cannot start and members cannot join; dropped clients cannot get back in. Sessions
whose members stay connected keep working.

## Dashboards

- `$GRAFANA/d/centcom-relay-overview?var-env=$ENV`: "Handshake p95 (B038)", "Upgrades refused",
  "Closes by code", "Open connections by region".

## Triage commands

1. Which results fail (Grafana Explore):
   `sum by (result) (rate(centcom_relay_handshake_duration_seconds_count{env="$ENV"}[5m]))`.
2. Which region: `sum by (region) (rate(centcom_relay_handshake_duration_seconds_count{env="$ENV", result!="ok"}[5m]))`,
   then `fly status -a centcom-$ENV-relay`.
3. Are upgrades refused before the handshake:
   `sum by (reason) (rate(centcom_relay_upgrades_refused_total{env="$ENV"}[5m]))`.
4. Can the relay verify tickets: `curl -sS "$API/.well-known/jwks.json"` must answer 200 (the relay
   closes with 4503 when the API's JWKS is unreachable and its cache is stale), and the relay is
   ready: `curl -sS "$RELAY/readyz"`.
5. Errors: `fly logs -a centcom-$ENV-relay --no-tail | grep '"level":"error"' | tail -n 50`.

## Mitigation

- One region is bad: stop its broken machines (`fly machine stop <machine id> -a centcom-$ENV-relay`);
  clients reconnect to healthy relays.
- JWKS unreachable: fix the API first ([ApiAvailabilityFastBurn](ApiAvailabilityFastBurn.md)).
- Overloaded: see [RelayOverloaded](RelayOverloaded.md); `fly scale count <n + 1> -a centcom-$ENV-relay --region <region>`.
- A release caused it: roll back with `fly deploy -a centcom-$ENV-relay --image <previous image>`,
  one region at a time.

## Escalation

Page the secondary on-call after 20 minutes without a lead; the realtime team for relay code.
Open a status incident on the affected `relay-<region>` component.

## Verification

`slo:burn_rate:5m{slo="relay-connect", env="$ENV"}` under 1 and the handshake p95 under 2 s on the
relay overview; the alert resolves
(`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=RelayConnectBurn env=$ENV`).

## Post-incident

Record the regions and duration, the budget spent, and whether the client's reconnect backoff
behaved (B011's simulator can replay the pattern). File follow-ups with the realtime team.

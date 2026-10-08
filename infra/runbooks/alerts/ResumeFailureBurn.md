# ResumeFailureBurn

Severity: `page` (14.4x over 1 h and 5 m, or 6x over 6 h and 30 m), `ticket` (3x over 3 d) ·
Service: `relay` · Owner: `realtime` · SLO: `resume-success` (99 % of resumes succeed within 5 s) ·
Rules: [relay.rules.yaml](../../alerts/rules/relay.rules.yaml)

## Symptoms

Session resumes fail or take over 5 s: 14.4 % or more over an hour (fast), 6 % over 6 hours (slow)
or 3 % over 3 days (ticket). Customers report losing their place after a network blip: the client
rejoins from a snapshot, or not at all.

## Impact

Members who reconnect miss frames or are forced to rejoin; hosts may lose queued prompts from
guests. It often follows a relay restart or a Redis problem, when many clients resume at once.

## Dashboards

- `$GRAFANA/d/centcom-relay-overview?var-env=$ENV`: "Resumes by result (B042)", "Closes by code",
  "Open connections by region".

## Triage commands

1. Why resumes fail (Grafana Explore): `sum by (result) (rate(centcom_relay_resume_total{env="$ENV"}[5m]))`.
2. Did many clients reconnect at once (a relay restart or deploy):
   `sum by (region) (centcom_relay_connections{env="$ENV"})` over the last hour, and
   `fly releases -a centcom-$ENV-relay`.
3. Is the resume state in Redis reachable: `redis-cli -u "$REDIS_URL" ping` and the "Redis errors"
   panel on `$GRAFANA/d/centcom-database-redis?var-env=$ENV`.
4. Errors: `fly logs -a centcom-$ENV-relay --no-tail | grep resume | grep '"level":"error"' | tail -n 50`.

## Mitigation

- A restart storm: wait for the reconnect wave to pass (clients back off with jitter); do not
  restart more relays.
- Redis trouble: see [RedisMemoryHigh](RedisMemoryHigh.md); resume state lives there.
- A release caused it: roll back one region at a time,
  `fly deploy -a centcom-$ENV-relay --image <previous image>`.

## Escalation

Page the secondary on-call after 30 minutes; the realtime team owns resume logic.

## Verification

`slo:burn_rate:5m{slo="resume-success", env="$ENV"}` under 1 and the failing results from step 1
back to their usual rate; the alert resolves
(`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=ResumeFailureBurn env=$ENV`).

## Post-incident

Record what triggered the reconnects and how many resumes failed; follow up with the realtime team
on anything that made resumes fail rather than just slow down.

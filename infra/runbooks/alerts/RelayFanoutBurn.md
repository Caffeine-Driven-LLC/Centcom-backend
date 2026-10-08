# RelayFanoutBurn

Severity: `page` (14.4x over 1 h and 5 m, or 6x over 6 h and 30 m), `ticket` (3x over 3 d) ·
Service: `relay` · Owner: `realtime` · SLO: `relay-fanout` (99 % of frames delivered in-region
within 150 ms) · Rules: [relay.rules.yaml](../../alerts/rules/relay.rules.yaml)

## Symptoms

Frames take over 150 ms from receipt to in-region delivery for 14.4 % or more of frames over an
hour (fast), 6 % over 6 hours (slow) or 3 % over 3 days (ticket). Customers see other members'
prompts, approvals and agent output arrive late or in bursts.

## Impact

Collaboration in sessions lags; approvals and queue updates arrive late. Nothing is lost: frames
are sequenced and delivered late, not dropped (dropped frames show up as resume failures).

## Dashboards

- `$GRAFANA/d/centcom-relay-overview?var-env=$ENV`: "Fan-out latency p95 (B044)", "Frames by type",
  "Outbound buffer p95 (B046)", "Open connections by region".

## Triage commands

1. Which region is slow (Grafana Explore):
   `histogram_quantile(0.95, sum by (region, le) (rate(centcom_relay_fanout_latency_seconds_bucket{env="$ENV"}[5m])))`.
2. Is it load: `sum by (region) (rate(centcom_relay_frames_total{env="$ENV"}[5m]))` and
   `sum by (region) (centcom_relay_connections{env="$ENV"})` against last week.
3. Are slow consumers filling buffers:
   `histogram_quantile(0.95, sum by (le) (rate(centcom_relay_outbound_buffer_bytes_bucket{env="$ENV"}[5m])))`.
4. Is Redis pub/sub slow (cross-node fan-out goes through Redis):
   `histogram_quantile(0.95, sum by (le) (rate(centcom_redis_ping_seconds_bucket{env="$ENV"}[5m])))`.
5. Machine load: `fly status -a centcom-$ENV-relay` and `fly machine status <machine id> -a centcom-$ENV-relay`.

## Mitigation

- Load in one region: `fly scale count <n + 1> -a centcom-$ENV-relay --region <region>`.
- Redis slow or near its memory limit: see [RedisMemoryHigh](RedisMemoryHigh.md).
- A release caused it: roll back one region at a time,
  `fly deploy -a centcom-$ENV-relay --image <previous image>`.

## Escalation

Page the secondary on-call after 30 minutes; the realtime team for relay code and capacity.

## Verification

`slo:burn_rate:5m{slo="relay-fanout", env="$ENV"}` under 1 and the fan-out p95 under 150 ms per
region; the alert resolves
(`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=RelayFanoutBurn env=$ENV`).

## Post-incident

Record peak frames per second and connections per region; capacity follow-ups go to the realtime
team (B095's load profiles can reproduce the load).

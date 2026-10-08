# ReadyzFailing

Severity: `ticket` · Service: `platform` · Owner: `platform` · Metric: `probe_success`
(blackbox_exporter, `job="readyz"`, see [exporters.yaml](../../alerts/exporters.yaml)) · Rules:
[platform.rules.yaml](../../alerts/rules/platform.rules.yaml)

## Symptoms

More than one instance of a component (`component`: `api` or `relay`) has failed its `/readyz`
probe for 5 minutes. `/readyz` checks the database, Redis and the migration version (B086 for the
API, B037 for the relay) and answers 503 while draining.

## Impact

The load balancer stops sending traffic to those instances, so capacity drops; the rest carry the
load. When a shared dependency is the cause, every instance follows and the SLO alerts page.

## Dashboards

- `$GRAFANA/d/centcom-api-overview?var-env=$ENV`: "Requests by status class".
- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Pool timeouts and lost connections", "Redis
  errors".

## Triage commands

1. Which instances (Grafana Explore): `probe_success{env="$ENV", job="readyz"} == 0`.
2. What a failing machine's `/readyz` says. Through the load balancer you only reach healthy
   machines, so name the machine: `curl -sS -H "fly-force-instance-id: <machine id>" "$API/readyz"`
   (or `"$RELAY/readyz"`); the `checks` object names the failing dependency (`db`, `redis`,
   `migrations`).
3. Machine ids and their health checks: `fly status -a centcom-$ENV-<component>` and
   `fly checks list -a centcom-$ENV-<component>`.
4. Is a deploy draining them: `fly releases -a centcom-$ENV-<component>`.

## Mitigation

- `migrations` false after a deploy: the release ran ahead of its migration (B092 runs them
  first); finish the migration or roll the service back.
- `db` or `redis` false: see [DbPoolSaturation](DbPoolSaturation.md),
  [PostgresReplicationLag](PostgresReplicationLag.md) or [RedisMemoryHigh](RedisMemoryHigh.md) and
  the provider's status page.
- One machine stuck: `fly machine restart <machine id> -a centcom-$ENV-<component>`.

## Escalation

A ticket for the platform team. If more than half of a component's instances fail, treat it as an
incident and page through the primary on-call.

## Verification

`count by (component) (probe_success{env="$ENV", job="readyz"} == 0)` returns nothing, and
`curl -sS -H "fly-force-instance-id: <machine id>" "$API/readyz"` answers 200 for the machines that
failed.

## Post-incident

Record the failing check and the cause; a flapping check needs its timeout reviewed
(`READYZ_TIMEOUT_MS`, B086).

# RelayConnectionDrop

Severity: `ticket` · Service: `relay` · Owner: `realtime` · Inhibited while a deploy runs in the
same environment (B092's `deploy_in_progress` marker) · Rules:
[relay.rules.yaml](../../alerts/rules/relay.rules.yaml)

## Symptoms

Open relay connections in a region fell by more than 30 % within 5 minutes, from at least 100. A
region whose relays stopped reporting counts as zero.

## Impact

Many clients were disconnected at once: a relay crashed, a region lost its network, or Redis or the
API failed under the relays. Clients reconnect and resume on their own; when that fails,
[RelayConnectBurn](RelayConnectBurn.md) and [ResumeFailureBurn](ResumeFailureBurn.md) page.

## Dashboards

- `$GRAFANA/d/centcom-relay-overview?var-env=$ENV`: "Open connections by region", "Closes by code",
  "Handler errors", "Resumes by result (B042)".

## Triage commands

1. Confirm and size it (Grafana Explore):
   `sum by (region) (centcom_relay_connections{env="$ENV"})` over the last hour.
2. Was it a deploy the inhibition missed: `fly releases -a centcom-$ENV-relay`, and the deploy
   marker: `amtool --alertmanager.url="$ALERTMANAGER_URL" alert query deploy_in_progress=true env=$ENV`.
3. How connections closed: `sum by (code) (increase(centcom_relay_close_total{env="$ENV"}[10m]))`
   (1001 going away, 1006 abnormal, 4503 overloaded).
4. Are the machines up: `fly status -a centcom-$ENV-relay`, and the logs of a machine that
   restarted: `fly logs -a centcom-$ENV-relay --no-tail | grep '"level":"fatal"\|"level":"error"' | tail -n 50`.
5. Are clients coming back: "Open connections by region" on
   `$GRAFANA/d/centcom-relay-overview?var-env=$ENV` recovers within minutes when reconnects work.

## Mitigation

- Clients are reconnecting: nothing to do but watch the resume and connect SLOs.
- A relay crash-loops: stop it, `fly machine stop <machine id> -a centcom-$ENV-relay`, and look at
  its last logs.
- A bad release: roll back that region, `fly deploy -a centcom-$ENV-relay --image <previous image>`.
- A region's network is down: check the Fly status page; clients fail over to other regions.

## Escalation

A ticket for the realtime team. If it repeats within a day or reconnects fail, raise it to the
primary on-call as an incident.

## Verification

`sum by (region) (centcom_relay_connections{env="$ENV"})` is back near its level before the drop,
and `sum by (result) (rate(centcom_relay_resume_total{env="$ENV"}[5m]))` shows resumes succeeding.

## Post-incident

Record the cause and how fast clients came back. If deploys trigger it, check that B092's pipeline
posts the deploy marker (see [the on-call handbook](../../../docs/ops/oncall.md#deploy-windows)).

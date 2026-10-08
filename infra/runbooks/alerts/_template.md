# AlertName

Severity: `page` | `ticket` | `info` · Service: `service` · Owner: `team` · Rules:
`infra/alerts/rules/<service>.rules.yaml`

Copy this file to `<AlertName>.md` when adding an alert (B094); the alert's `runbook` label points
at it. Every section below is required and `pnpm alerts:lint` checks them: each triage step needs
a command or a dashboard link, and Verification needs one too. Write for someone who has never seen
the system, using the variables in the on-call handbook's conventions (`docs/ops/oncall.md`).
Never paste customer data (ids, e-mail addresses, content) into commands, tickets or the status
page.

## Symptoms

What fired, what it measures and the threshold; what support or customers report.

## Impact

Who is affected and how badly; what gets worse the longer it lasts.

## Dashboards

- `$GRAFANA/d/<uid>?var-env=$ENV`: the panels to look at first.

## Triage commands

1. Confirm the signal: `<PromQL in Grafana Explore, or a command>`.
2. Narrow it down (which region, instance, queue or dependency): `<command>`.
3. Look for the cause (recent deploy, dependency down, load): `<command>`.

## Mitigation

What stops the damage, safest first, each with its command.

## Escalation

When to page the secondary or the owner team, and when to open a status incident.

## Verification

The command or query that shows recovery, and the value to expect.

## Post-incident

What to record, what to follow up, and when to revisit the alert's threshold.

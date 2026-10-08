# On-call handbook

Lane B094. How alerts reach people, what each severity asks of them, and how an incident runs. The
alert rules are in [infra/alerts/](../../infra/alerts/README.md), one runbook per alert in
[infra/runbooks/alerts/](../../infra/runbooks/alerts/_template.md), the dashboards and SLOs in
[observability.md](observability.md) (B093).

## Severities

| Severity | Means                                                                                                      | Goes to                                                                                      | Response                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `page`   | Customers notice now (an SLO burning fast), or data is at risk (dead letters). At most 10 alerts may page. | Primary on-call at once; fallback channel 5 min, secondary 15 min after, unless acknowledged | Acknowledge within 5 minutes, any hour; work it until mitigated |
| `ticket` | Something needs a fix within a working day; nobody is woken                                                | The ticket queue, once a day while it fires                                                  | Triage the next working day                                     |
| `info`   | Context for whoever is looking                                                                             | The info channel                                                                             | None                                                            |

A page that fires again keeps notifying every 4 hours while it fires. While a service pages, its
tickets and info alerts are held back (inhibited) so the page is the one thing to look at.

### Acknowledging

Acknowledge a page by silencing it in Alertmanager, in Grafana (Alerting > Silences) or with:

```bash
amtool --alertmanager.url="$ALERTMANAGER_URL" silence add alertname=<alert> env=$ENV \
  --duration=2h --comment="ack: <your name>, investigating"
```

An acknowledgement in the PagerDuty or Opsgenie app alone does not stop the escalation to the
fallback channel and the secondary: routing happens in Alertmanager (see
[infra/alerts/README.md](../../infra/alerts/README.md#routing)). Keep silences short and extend
them; an expired silence while the alert still fires escalates again, on purpose.

## Rotation

- Two people are on call each week: the primary takes every page, the secondary takes pages the
  primary has not acknowledged in 15 minutes and helps when asked.
- The week starts Monday 10:00 (the team's time zone). Last week's secondary becomes primary, so
  everyone is secondary before being primary.
- Nobody is on call two weeks in a row unless they ask. Swaps are fine: change the schedule in the
  pager tool, not in a chat message.
- After a night with a page, the primary hands the next morning to the secondary.
- The contact points (who the pager, fallback, ticket and info receivers reach) are configuration,
  not code: `ALERT_CONTACT_*` variables, set per environment
  ([infra/alerts/README.md](../../infra/alerts/README.md#contact-points)).

### Handover

At the start of each week the outgoing primary writes, in the on-call channel:

1. open incidents and their state, and status page incidents still open;
2. active silences and why (`amtool --alertmanager.url="$ALERTMANAGER_URL" silence query`);
3. alerts that fired more than once, with the ticket each got;
4. anything changed in alerting or runbooks that week.

The incoming primary checks they can reach Grafana, Alertmanager, `fly` and the admin console
before the outgoing one leaves.

## Incident roles

An incident is any page that is not resolved within 15 minutes, or anything customers report
widely. One person can hold several roles in a small incident; hand roles over explicitly.

| Role                | Does                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Incident commander  | Owns the incident: decides, delegates, calls the end. The primary until they hand it over. |
| Operations lead     | Runs the runbook, the commands and the fix. Says what they will run before running it.     |
| Communications lead | Updates the status page and support every 30 minutes, and the team channel.                |
| Scribe              | Keeps a timeline (times in UTC) of what was seen, decided and done, for the postmortem.    |

Page the secondary for any role you cannot cover. Bring in the owning team (the alert's `owner`
label) for code changes.

## Status page updates

Customers see incidents in `GET /v1/status` (B086), which the client and the web app show as a
banner. Open an incident once customers have been affected for 5 minutes, through the admin console
(`/incidents`, B088) or the admin API (B087, on the private network):

```bash
curl -sS -X POST "$ADMIN/internal/admin/v1/incidents" \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "X-Admin-Reason: incident <alert name>: customer impact" \
  -H "Content-Type: application/json" \
  -d '{"title":"Elevated API errors","component_ids":["api"],"status":"investigating"}'
```

- `component_ids` come from `STATUS_COMPONENTS` (for example `api`, `relay-eu`, `jobs`).
- Update at least every 30 minutes, moving through `investigating`, `identified`, `monitoring` and
  `resolved`:
  `POST $ADMIN/internal/admin/v1/incidents/<incident id>/updates` with
  `{"text":"…","status":"identified"}`.
- Titles are at most 120 characters and updates 500. Incidents are public: never name a customer,
  a workspace, an address or a cause that reveals one. Describe symptoms ("some sign-ins fail"),
  not internals.
- Resolve it once the alert has resolved and the verification step of its runbook holds. It stays
  on the feed for 7 days.

## Deploy windows

B092's deploy pipeline marks a deploy by posting an alert to Alertmanager for its duration, with
the label `deploy_in_progress="true"`:

```bash
amtool --alertmanager.url="$ALERTMANAGER_URL" alert add DeployInProgress \
  deploy_in_progress=true env=$ENV service=relay --end="<now + 30 minutes, RFC 3339>"
```

The marker never notifies anyone. While it is active, `RelayConnectionDrop` is inhibited in that
environment, because a rolling relay deploy sheds connections on purpose. Other alerts are not
inhibited: a deploy that breaks an SLO still pages.

## Conventions

Runbook commands use these variables; set them in your shell from the team's password manager or
the secret manager (B091), never paste their values into tickets or chat:

| Variable                       | Is                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `ENV`                          | `prod` or `stage` (Fly apps are `centcom-$ENV-api`, `-relay`, `-worker`, B091) |
| `API`                          | The API's base URL, for example `https://api.<domain>`                         |
| `RELAY`                        | One relay region's base URL, for example `https://relay-<region>.<domain>`     |
| `ADMIN`                        | The admin API on the private network (B087)                                    |
| `GRAFANA`                      | The Grafana stack's URL; dashboards are `$GRAFANA/d/<uid>?var-env=$ENV`        |
| `ALERTMANAGER_URL`             | The Alertmanager API (Grafana Cloud's, for `amtool`)                           |
| `DATABASE_URL`                 | The primary Postgres, read-only role where the runbook only reads              |
| `REPLICA_URL`                  | A Postgres replica                                                             |
| `REDIS_URL`                    | Redis                                                                          |
| `BACKUP_BUCKET`, `R2_ENDPOINT` | The `backups` bucket and the R2 endpoint (B091, B099)                          |
| `STAFF_TOKEN`                  | Your own staff access token for the admin API, never someone else's            |

PromQL in the runbooks runs in Grafana Explore against the metrics data source. Never copy
customer data (ids, e-mail addresses, content) out of logs, Redis or the database into a ticket, a
chat or the status page; counts are enough.

## Postmortems

Every page that became an incident gets a blameless postmortem within 5 working days, in the
team's docs space:

1. Summary: what customers saw, for how long, and the SLO budget spent.
2. Timeline (UTC): first signal, page, acknowledgement, mitigation, resolution.
3. Cause and contributing factors, without blame.
4. What went well and what did not, including the alert and its runbook: did it fire early
   enough, and did the runbook's steps work?
5. Follow-ups, each with an owner and a ticket; runbook corrections go in the same week.

## Tabletop drills

A tabletop drill walks through runbooks without an incident: pick alerts at random, imagine the
alert firing, and follow each runbook step against the code, the dashboards and the configuration
as they are. Run one for every alerting release (`Alerting release` in
[infra/alerts/README.md](../../infra/alerts/README.md)) and record it below, newest first; the
alerting tests check that the newest record covers the current release, names 3 existing alerts
and has every checklist item done.

Checklist, for each drilled alert:

- [ ] Each triage step names a real metric, label, dashboard panel, command or endpoint.
- [ ] Each command would work as written, with the variables above.
- [ ] Mitigation and escalation say who does what, without guessing.
- [ ] Verification gives a value to expect.
- [ ] Anything wrong or missing was fixed in the runbook, or filed.

### 2026-10-08: alerting v1

- Release: alerting v1
- Participants: Claude (B094's author), a desk walk-through against this repository. A human
  reviewer should repeat it on the first stage deploy (see Findings).
- Alerts (a seeded random draw, `random.Random(20261008).sample(sorted(alerts), 3)` in Python over
  the 19 alert names): `ReadyzFailing`, `ApiAvailabilitySlowBurn`, `RelayOverloaded`.
- Checklist:
  - [x] Each triage step names a real metric, label, dashboard panel, command or endpoint.
  - [x] Each command would work as written, with the variables above.
  - [x] Mitigation and escalation say who does what, without guessing.
  - [x] Verification gives a value to expect.
  - [x] Anything wrong or missing was fixed in the runbook, or filed.
- Findings and changes:
  - `ReadyzFailing`: `curl "$API/readyz"` goes through the load balancer, which only reaches
    healthy machines, so it showed nothing. Steps 2 and Verification now name the machine with
    Fly's `fly-force-instance-id` header, and step 3 adds `fly checks list`. The alert reads
    blackbox_exporter's `probe_success{job="readyz"}`, which exists only once B091 deploys the
    exporter: filed as a follow-up in the B094 PR.
  - `ApiAvailabilitySlowBurn`: step 4 grepped error lines for a route, but the route template is
    in the access log line (`http.request`, with `route` and `status`), not in error lines. It now
    filters the access log by route and 5xx status and follows the `request_id`.
  - `RelayOverloaded`: the relay does not log 4503 closes, so `fly logs | grep 4503` found nothing;
    the step is gone. The relay also closes with 4503 while it is not ready, not only at the
    connection cap, so a per-machine `/readyz` step and a "not ready: fix the dependency, adding
    relays does not help" mitigation were added. The buffer step reads a histogram B046 has not
    shipped yet; the step says so.

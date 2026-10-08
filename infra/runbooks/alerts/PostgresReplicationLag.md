# PostgresReplicationLag

Severity: `ticket` · Service: `postgres` · Owner: `platform` · Metric: `pg_replication_lag_seconds`
(postgres_exporter, see [exporters.yaml](../../alerts/exporters.yaml)) · Rules:
[postgres.rules.yaml](../../alerts/rules/postgres.rules.yaml)

## Symptoms

A Postgres replica has been more than 30 s behind the primary for 2 minutes (prod runs an HA
primary and a replica, B091).

## Impact

Nothing customers see while the primary is healthy. A failover now would lose the transactions the
replica has not replayed (the RPO target is 5 minutes, B099), and any read served from the replica
is stale.

## Dashboards

- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Pool connections by state" and "Pool
  saturation" (write load on the primary); the database provider's own metrics page for the
  replica's CPU, disk and network.

## Triage commands

1. Confirm the lag and its trend (Grafana Explore): `max by (instance) (pg_replication_lag_seconds{env="$ENV"})`.
2. Ask the replica directly:
   `psql "$REPLICA_URL" -c "select now() - pg_last_xact_replay_timestamp() as lag, pg_is_in_recovery()"`.
3. Is the primary sending: `psql "$DATABASE_URL" -c "select application_name, state, sent_lsn, replay_lsn, replay_lag from pg_stat_replication"`.
4. Is a long query on the replica holding replay back:
   `psql "$REPLICA_URL" -c "select pid, now() - xact_start as age, state from pg_stat_activity where xact_start is not null order by age desc limit 5"`.
5. Is the primary under a write burst (a migration, a purge, a backfill):
   `fly releases -a centcom-$ENV-api` and the worker's recent jobs on
   `$GRAFANA/d/centcom-workers-queues?var-env=$ENV` ("Jobs run").

## Mitigation

- A long replica query blocks replay: cancel it, `psql "$REPLICA_URL" -c "select pg_cancel_backend(<pid>)"`.
- A write burst from a job: pause it (scale the worker down for a while,
  `fly scale count 0 -a centcom-$ENV-worker`, then back) if the lag keeps growing.
- The replica is undersized or broken: the provider's console (resize or rebuild the replica).

## Escalation

A ticket for the platform team. Raise it to the primary on-call if the lag passes 5 minutes (the
RPO) or keeps growing for an hour: a failover during that time would lose data.

## Verification

`max(pg_replication_lag_seconds{env="$ENV"})` stays under 5 s, and the query in step 2 shows a lag
of seconds.

## Post-incident

Record the cause and the peak lag. If a job caused it, give the job a smaller batch or a pause
between batches (B090's retention batches are 1 000 rows for this reason).

# BackupStale

Severity: `ticket` · Service: `backup` · Owner: `platform` · Metric: `centcom_backup_age_seconds`
(B099's `backup-verify` job; until it lands the rule is non-prod only) · Rules:
[backup.nonprod.rules.yaml](../../alerts/rules/backup.nonprod.rules.yaml)

## Symptoms

The newest Postgres base backup is over 26 hours old (`BACKUP_MAX_AGE_S`, 93 600 s), for 15
minutes. Base backups are daily, so one has been missed.

## Impact

Nothing customers see. A restore would start from an older base and replay more WAL, so it takes
longer (the RTO target is 60 minutes, B099); if WAL archiving has stopped too, data since the last
good backup is at risk.

## Dashboards

- `$GRAFANA/d/centcom-database-redis?var-env=$ENV` for the database's state; the backup metrics
  themselves are in the queries below until B099 adds a panel.

## Triage commands

1. How old (Grafana Explore): `max(centcom_backup_age_seconds{env="$ENV"}) / 3600` in hours, and
   the WAL archive: `max(centcom_wal_archive_lag_seconds{env="$ENV"})`.
2. Did the backup job run: `fly logs -a centcom-$ENV-worker --no-tail | grep backup | tail -n 20`.
3. What is in the bucket: `aws s3 ls "s3://$BACKUP_BUCKET/" --endpoint-url "$R2_ENDPOINT" | tail -n 5`
   (the `backups` R2 bucket, B091).

## Mitigation

- Start a base backup by hand with B099's tooling (`infra/dr/`), then check step 3 again.
- WAL archiving stopped as well: treat it as urgent (raise to the primary on-call): the recovery
  point is moving back in time.

## Escalation

A ticket for the platform team during working hours; the primary on-call if WAL archiving is also
behind or the backup is over 48 hours old.

## Verification

`max(centcom_backup_age_seconds{env="$ENV"})` drops under 86 400 after the next backup, and step 3
lists today's backup.

## Post-incident

Record why the backup was missed; B099's monthly restore drill should cover the fix.

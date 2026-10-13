# Restore the database from a backup

Use for: the database is corrupted, a bad migration or a bad release damaged data, or someone
deleted data. Targets for the single-server layout: **RPO = age of the newest backup (nightly, so
up to about 26 h)**, **RTO 60 min** (a restore of the current data size takes seconds to minutes;
the drill measures it). Notify: the on-call lead and whoever owns privacy (step 6).

## 1. Decide whether you need a restore

- A bad release without data damage: `infra/deploy/rollback.sh --images` is enough (no restore).
- Data damage within the last minutes and the damage is small: consider fixing the rows by hand
  from a copy restored in step 3, instead of rolling the whole database back.

## 2. Find the backup

```sh
cd /opt/centcom
infra/dr/backup-status.sh                 # newest backup age
bash -c 'source infra/dr/lib.sh; s3_list db/'   # every backup with its time
```

Pick the newest backup from before the damage. If the damage is older than the newest backup, the
backup already contains it: take an older one (backups are kept 35 days).

## 3. Look before you leap: restore into an isolated copy

```sh
infra/dr/restore.sh --key db/centcom-<time>.dump.gpg --keep
```

It starts a throwaway Postgres with **no network** (nothing can reach production from it),
restores, verifies the migration version and every table's rows and md5 against the manifest,
and prints the container name. Inspect it: `docker exec -it <name> psql -U centcom centcom`. Remove
it with `docker rm -f <name>` when done.

## 4. Replace the live database

Only when step 3 shows what you expect. This stops the application for a minute or two and
**loses everything written since the backup**:

```sh
infra/dr/restore.sh --key db/centcom-<time>.dump.gpg --into stack --i-know-deletions-may-reappear
```

It stops api, worker, relay and Caddy, recreates the database, restores, verifies, and starts the
services. If verification fails the services stay stopped: read the output, do not start them.
Exit codes: 3 wrong `BACKUP_PASSPHRASE`; 1 the backup does not match its manifest; 4 verification
failed.

## 5. After

1. `curl https://api.<domain>/readyz` is 200.
2. Take a backup now: `infra/dr/backup.sh`.
3. Write the incident down: time of damage, backup used, data lost window.

## 6. Account deletions (privacy)

A restore brings back every account whose deletion happened after the backup. There is no
external deletion log yet (lane B026 keeps deletions only in the database). Until one exists:

1. List the deletions made since the backup from support tickets and the audit trail of the
   damaged database, **before** you replace it (copy it first with `infra/dr/backup.sh`).
2. After the restore, have each of those accounts deleted again through the normal flow, and tell
   the privacy owner. Do this before the restored system is announced as healthy.
3. The old backup files that contain those accounts are removed by the 35-day retention
   (`infra/dr/prune.sh`).

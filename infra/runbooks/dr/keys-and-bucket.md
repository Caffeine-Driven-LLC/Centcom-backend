# Lost passphrase, lost bucket credentials, or a compromised backup bucket

## `BACKUP_PASSPHRASE` is lost

Backups are encrypted with it and nothing else can open them. Look for the copies first: the
password manager entry and the **offline copy held by two named people** (names go here when the
team is set: ____ and ____). If none exists the existing backups are unreadable.

1. Set a new passphrase in `production.env`, run `infra/dr/backup.sh` immediately: the data is
   protected again from that moment.
2. Run `infra/dr/drill.sh` to prove the new backup restores.
3. Keep the old backups until the 35-day limit (they cannot be opened but cost almost nothing), or
   delete them; then store the new passphrase in the password manager **and** the offline copy.

## The passphrase leaked

The attacker can read every backup they can get hold of, past and future.

1. Rotate: new passphrase, new backup, drill (as above).
2. Delete the old backups from the bucket (`infra/dr/prune.sh` with `BACKUP_RETENTION_DAYS=1` keeps
   only the newest 3; delete those three by hand once the new ones exist).
3. Treat it as a data exposure: the privacy owner decides on notification.

## Bucket credentials leaked or the bucket is compromised

1. Revoke the access key in Cloudflare R2 / Backblaze B2 and create a new one scoped to this
   bucket only (object read and write; no bucket administration).
2. Put the new key in `production.env`; run `infra/dr/backup-status.sh` and `infra/dr/backup.sh`.
3. An attacker with write access could have deleted or replaced backups: enable bucket versioning
   (R2: object lifecycle / B2: keep all versions) and check that `infra/dr/drill.sh --use-latest`
   still passes. A replaced backup fails the SHA-256 check against its manifest, or does not
   decrypt, so it is refused at restore time rather than silently loaded.
4. The data in the bucket is ciphertext; without the passphrase it is not readable.

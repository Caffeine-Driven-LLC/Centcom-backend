# The server is gone: rebuild from backups

Use for: the VPS was deleted, the disk failed, the provider lost the region. Target RTO 4 h (new
server, DNS, restore). Everything needed is **off the server**: the git repository, `production.env`
(password manager), the backup bucket (R2 or B2) and `BACKUP_PASSPHRASE` (password manager and the
offline copy). Notify: on-call lead; status page.

## Rebuild order

1. **New server** (same size or larger), Ubuntu, Docker with the compose plugin, `gnupg` and
   `curl`, a non-root user, firewall 22/80/443 (docs/ops/deployment.md "One-time setup").
2. **Cloudflare**: point the proxied `api` and `relay` records at the new IP.
3. **Code and settings**: `git clone`, then put the saved `infra/deploy/production.env` in place
   (`chmod 600`). If it is lost, `node infra/deploy/gen-env.mjs` makes a new one, but then every
   secret changes: all users sign in again, and **`BACKUP_PASSPHRASE`, the `BACKUP_S3_*` values and
   the database password must be put back by hand** (a new passphrase cannot read old backups).
4. **Empty stack**: `infra/deploy/deploy.sh <tag>` (the tag you ran before: `git tag`). It builds,
   migrates an empty database and starts everything.
5. **Data**: `infra/dr/restore.sh --latest --into stack --i-know-deletions-may-reappear`, then follow
   `restore-database.md` step 6 for account deletions.
6. **Check**: `/readyz`, sign in, open a session, `infra/dr/backup.sh`.
7. **Session history**: if `OBJECT_STORE_*` points at R2/B2 the history is already there. If it was
   the bundled MinIO, its volume was on the lost disk and the history is gone (see
   docs/ops/backup-and-dr.md "What is not covered").

Time it (the drill report gives the restore part): server 10 min, DNS 5 min, deploy 10 min, restore
a few minutes.

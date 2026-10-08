-- The in-app inbox (B065, CT-API-NOTIFY): `unread=true` lists, and every list's X-Unread-Count
-- counts, a user's unread inbox rows of the last 90 days. B063's (user_id, created_at, id) index
-- serves the plain list, but for those two it would walk every read row too. This partial index
-- holds the unread inbox rows only, so both stay short range scans however much a user has read,
-- and read-all's batches find their next 500 rows the same way.
--
-- The predicate is written as the inbox queries write it (`read_at is null` and
-- `'inbox' = any (channels)` as literals), so the planner can use the index.
--
-- Named after main's newest migration (20260102001700, B064); the card names no migration.

create index notifications_inbox_unread_idx on notifications (user_id, created_at, id)
  where read_at is null and 'inbox' = any (channels);

-- rollback note: drop index if exists notifications_inbox_unread_idx; nothing depends on it.

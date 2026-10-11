-- Metadata search indexes (B089): trigram indexes on the cleartext names staff search over
-- (session names, workspace names and slugs, user display names) and a pattern index on user
-- emails. Nothing from a session's content is indexed: the history, queue bodies, comments and
-- branch names live in ciphertext or are never stored (`apps/api/test/search/search.scope.test.ts`
-- checks every index of these tables against an allow-list).
--
-- `pg_trgm` is a trusted extension (Postgres 13+); a server without it fails this migration at once,
-- and the API's `assertSearchReady` refuses to start search with a clear error.
--
-- The card names the file `089_search_indexes.sql`; the migration runner accepts only 14-digit
-- versions, so it is the next one after main's and every open PR's newest. Beyond the card's four
-- indexes, `idx_workspaces_slug_trgm` serves the slug half of a workspace search.

-- Building the indexes locks each table for writes briefly.
set local lock_timeout = '5s';

create extension if not exists pg_trgm;

create index idx_sessions_name_trgm on sessions using gin (lower(name) gin_trgm_ops);
create index idx_workspaces_name_trgm on workspaces using gin (lower(name) gin_trgm_ops);
create index idx_workspaces_slug_trgm on workspaces using gin (slug gin_trgm_ops);
create index idx_users_display_trgm on users using gin (lower(display_name) gin_trgm_ops);
-- Email prefix and exact lookups (staff only).
create index idx_users_email_lower on users (lower(email::text) text_pattern_ops);

-- rollback note: drop index idx_users_email_lower, idx_users_display_trgm,
-- idx_workspaces_slug_trgm, idx_workspaces_name_trgm, idx_sessions_name_trgm; keep the extension
-- (dropping it fails if anything else uses it).

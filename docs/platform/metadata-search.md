# Metadata search

Staff tooling searches sessions, workspaces, users and workspace members by their cleartext
metadata: names, slugs, ids and (staff only) emails. It never searches content: messages, queue
bodies, code, diffs, paths, branch names, comments and history are ciphertext or never stored, and
no index covers them.

## What is searched

| Type        | Matched on                                                       | Label                                   |
| ----------- | ---------------------------------------------------------------- | --------------------------------------- |
| `session`   | name (substring), id (exact)                                     | name, `(ended)` when ended or expired   |
| `workspace` | name and slug (substring), id (exact)                            | `name (slug)`, `(deleted)` when deleted |
| `user`      | display name (substring), email (prefix, staff only), id (exact) | display name (`<email>` for staff)      |
| `member`    | the member's display name (substring), membership id (exact)     | display name                            |

The columns are the code's `SEARCHABLE_COLUMNS` allow-list
(`apps/api/src/modules/search/query.ts`); adding one is a reviewed change.

## How to call it

The API exposes no public search endpoint (the contracts define none). `searchPlugin` mounts
`GET /search?q=&type=&workspace=&limit=&cursor=` on the internal admin listener, behind B087's
`requireStaff`. Later member-facing features call `searchForMember`, which only sees the user's
workspaces and never emails.

Results come in CT-PAGE pages: `{data, next_cursor, has_more}`, at most 50 per page (default 20).

## Limits and failures

- Queries are 2 to 254 characters (an email's bound) without control characters; anything else is
  422 (`/q`).
- Each search runs under a 2 s statement timeout; a timeout or an unreachable database is 503 with
  `retry_after_s: 2`. A very common short query returns a full page and `has_more`.
- The query string is never logged (only its length and the types).

## Indexes

Migration `20260102005100_search_indexes.sql` installs `pg_trgm` and creates trigram GIN indexes on
the lower-cased session, workspace and user names (and workspace slugs) and a pattern index on
lower-cased emails. A server without `pg_trgm` fails the migration; `assertSearchReady` refuses to
start search without it.

Performance (tested): with 100 000 sessions, 50 000 users and 10 000 workspaces, the first page
of a trigram query takes at most 100 ms at the 95th percentile and its plan uses the session name
index.

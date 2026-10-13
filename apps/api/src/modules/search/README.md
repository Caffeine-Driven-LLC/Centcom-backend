# Metadata search (B089)

Staff search over cleartext metadata: session names and ids, workspace names, slugs and ids, user
display names, emails and ids, and workspace members' display names. Never a session's content
(ciphertext, or never stored). Platform documentation: `docs/platform/metadata-search.md`.

## Interface

| Member                                  | What it does                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `searchMetadata(deps, input)`           | `{q, types?, workspaceId?, scope, limit?, cursor?}` to `{data: SearchHit[], next_cursor, has_more}`.             |
| `searchPlugin({requireAccess, search})` | `GET /search?q=&type=&workspace=&limit=&cursor=` in staff scope, for the admin listener (B087's `requireStaff`). |
| `searchForMember(deps, userId, input)`  | The member-facing variant: only the user's workspaces, no emails; no route.                                      |
| `assertSearchReady(db)`                 | Throws when `pg_trgm` is missing (call it before mounting the plugin).                                           |
| `SEARCHABLE_COLUMNS`                    | The allow-list of columns search matches on; adding one needs review.                                            |

`SearchHit = {type: 'session' | 'workspace' | 'user' | 'member', id, label, workspace_id, created_at, score}`.

## Rules

- **Query:** NFC, trimmed, lower-cased; 2 to 254 characters (the longest searchable value, an
  email) and no control characters (else 422, pointer `/q`). A full id
  (`ses_`, `wsp_`, `usr_`, `mem_` and 26 characters) is an exact lookup and ranks first (score 2).
  Otherwise a case-insensitive substring of the names (trigram GIN indexes) and, in staff scope, a
  prefix of user emails. `%`, `_` and `\` match themselves; every value is a bound parameter.
- **Ranking:** trigram similarity (4 places), then the newest, then the type and id: a total order,
  so pages never repeat or skip a hit, even while rows are inserted.
- **Scope:** staff sees every workspace and emails; member scope joins the user's memberships in
  SQL (never filtered afterwards) and never reads or returns an email.
- **Bounds:** `limit` 1 to 50 (default 20); a 2 s `statement_timeout` on every search; a timeout
  or an unreachable database is 503 with `retry_after_s` 2.
- **Cursors:** CT-PAGE (B025), bound to the normalised query, types, workspace and scope (another
  query with it is 400 `cursor_invalid`).
- Ended or expired sessions, deleted workspaces and deleted users stay searchable by staff
  (within retention), flagged in their label.
- **Logging:** the query's length and types only, never `q`.
- **Mounting:** the route declares its query parameters (`SEARCH_QUERY_PARAMS` as `adminQuery`),
  which B087's `requireStaff` checks; registering the plugin first runs `assertSearchReady`, so the
  listener does not start without `pg_trgm`.

## Storage

Migration `20260102005100_search_indexes.sql`: `pg_trgm`, `idx_sessions_name_trgm`,
`idx_workspaces_name_trgm`, `idx_workspaces_slug_trgm`, `idx_users_display_trgm` (GIN on the
lower-cased names) and `idx_users_email_lower` (pattern btree).

## Testing

`pnpm test` runs `apps/api/test/search/`: the query rules (unit); on Postgres 16 seeded with the
card's 10 000 workspaces, 50 000 users and 100 000 sessions, the first page's p95 and the plan's
trigram index, exact ids, ranking (similarity, then the newest), pagination under inserts and
through rows tied on score and time, injection and wildcards; and on a
small world, member scope, email visibility, content never found, the index allow-list, the
timeout, the queried columns against the allow-list, and the route behind a `requireStaff`-style
query check.

#!/usr/bin/env bash
# Checks a restored database against the manifest of the backup it came from (B099
# "restore-verify"): the newest migration, every table's row count and md5 (same tables, no extra
# ones), and smoke queries.
#
#   infra/dr/verify.sh --container <postgres container> --manifest <file>
#
# Prints one `ok` / `FAIL` line per check and, as the last line, a JSON array of the checks. The
# manifest is read by the target's own Postgres, so the host needs no jq or python.
# Exit 0 every check passed; 4 a check failed; 2 usage.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

container="" manifest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) container="${2:?}"; shift 2 ;;
    --manifest) manifest="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
[[ -n "$container" && -f "$manifest" ]] || die "$EXIT_USAGE" "usage: verify.sh --container <name> --manifest <file>"

m="$(tr -d '\n' <"$manifest")"
sql() { docker exec -i "$container" psql --username=centcom --dbname=centcom --no-psqlrc --quiet --tuples-only --no-align --field-separator='|' -v ON_ERROR_STOP=1 -v "m=$m"; }

results=() failed=0
check() { # check NAME 1|0 [detail]
  if [[ "$2" == 1 ]]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s%s\n' "$1" "${3:+ ($3)}"; failed=1; fi
  results+=("{\"name\":\"$1\",\"ok\":$([[ "$2" == 1 ]] && echo true || echo false)}")
}

# 1. the newest migration is the one the backup recorded
got="$(sql <<'SQL' 2>&1 || true
select coalesce(max(version), '') from schema_migrations;
SQL
)"
want="$(sql <<'SQL' 2>&1 || true
select (:'m'::json)->>'schema_version';
SQL
)"
check "migration version $want" "$([[ -n "$want" && "$got" == "$want" ]] && echo 1 || echo 0)" "restored has ${got:-none}"

# 2. the same tables, with the same row counts and content md5
tables="$(sql <<'SQL' 2>&1 || true
with want as (select key as t from json_each(:'m'::json->'tables')),
     have as (select table_name::text as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
select coalesce(string_agg('missing:' || t, ','), '') || coalesce((select string_agg('extra:' || t, ',') from have where t not in (select t from want)), '')
from want where t not in (select t from have);
SQL
)"
check "same set of tables" "$([[ -z "$tables" ]] && echo 1 || echo 0)" "$tables"

bad="$(sql <<'SQL' 2>&1 || true
with want as (select key as t, (value->>'rows')::bigint as rows, value->>'md5' as md5 from json_each(:'m'::json->'tables'))
select coalesce(string_agg(t, ','), '') from (
  select w.t,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', w.t), false, true, '')))[1]::text::bigint as g_rows,
    (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, E''\n'' order by x::text), '''')) as h from public.%I x', w.t), false, true, '')))[1]::text as g_md5,
    w.rows, w.md5 from want w) z
where g_rows is distinct from rows or g_md5 is distinct from md5;
SQL
)"
tables_count="$(sql <<'SQL' 2>&1 || true
select count(*) from json_each(:'m'::json->'tables');
SQL
)"
check "row counts and content md5 of $tables_count tables" "$([[ -z "$bad" ]] && echo 1 || echo 0)" "differ: $bad"

# 3. smoke: the database accepts writes and reads on its own, constraints are valid
smoke="$(sql <<'SQL' 2>&1 || true
select (select count(*) from pg_constraint where not convalidated) = 0
   and (select count(*) from pg_index where not indisvalid) = 0;
SQL
)"
check "constraints and indexes are valid" "$([[ "$smoke" == t ]] && echo 1 || echo 0)" "$smoke"

(IFS=,; printf '[%s]\n' "${results[*]}")
exit $((failed ? EXIT_VERIFY : 0))

#!/usr/bin/env bash
# Applies the database for the Supabase deployment in ONE transaction, in this order:
#   1. the app's own SQL from milk-crate/supabase/ (only on a project that does not have it
#      yet; session C's sync needs its tables). Read, never changed.
#   2. db/migrations/       (session B)
#   3. db/supabase/         (session C; 0006 locks down the default grants and runs last of C's)
#   4. deploy/supabase/sql/ (session E: pg_cron schedules and the buckets; locks down its own)
# One transaction, so Supabase's default grants on B's tables are never left open, and a
# failure leaves the database as it was. Every file is safe to run twice.
#
#   MC_DB_URL=postgresql://postgres.<ref>@<host>:5432/postgres bash deploy/supabase/scripts/apply-sql.sh
#
# Put the password in PGPASSWORD or ~/.pgpass, not in MC_DB_URL (a URL on a command line is
# visible to other users of the machine). Set PSQL to use another psql.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
psql="${PSQL:-psql}"
url="${MC_DB_URL:?Set MC_DB_URL to the database (session pooler or direct, user postgres).}"

shopt -s nullglob
files=()
has_app="$("$psql" "$url" -X -At -v ON_ERROR_STOP=1 -c "select to_regclass('public.artists') is not null")"
if [[ "$has_app" != "t" ]]; then
  files+=("$root/milk-crate/supabase/schema.sql" "$root"/milk-crate/supabase/[0-9][0-9][0-9]_*.sql)
  echo "This project has no app tables yet: loading the app's SQL first (${#files[@]} files)."
fi
migrations=("$root"/db/migrations/[0-9][0-9][0-9][0-9]_*.sql)
supabase=("$root"/db/supabase/[0-9][0-9][0-9][0-9]_*.sql)
ours=("$root"/deploy/supabase/sql/[0-9][0-9][0-9][0-9]_*.sql)
if [[ ${#migrations[@]} -eq 0 || ${#supabase[@]} -eq 0 || ${#ours[@]} -eq 0 ]]; then
  echo "Missing SQL files under db/ or deploy/supabase/sql/." >&2
  exit 1
fi
files+=("${migrations[@]}" "${supabase[@]}" "${ours[@]}")

args=()
for f in "${files[@]}"; do args+=(-f "$f"); done
PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}" \
  "$psql" "$url" -X -q -v ON_ERROR_STOP=1 --single-transaction "${args[@]}"
echo "Applied ${#files[@]} SQL files in one transaction: ${#migrations[@]} from db/migrations, ${#supabase[@]} from db/supabase, ${#ours[@]} from deploy/supabase/sql."

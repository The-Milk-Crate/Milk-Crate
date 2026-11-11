#!/usr/bin/env bash
# Runs the database checks on a throwaway PostgreSQL cluster.
#
#   bash db/test/run.sh
#
# Starts a temporary cluster in a temp directory on a free local port, applies every file in
# db/migrations twice, checks the second run changed nothing, runs db/test/checks.sql, then
# stops the cluster and removes the directory, also when a check fails.
# No keys, no network, no Docker. Set PG_BIN to pick the PostgreSQL bin directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
migrations="$root/db/migrations"

if [[ -z "${PG_BIN:-}" ]]; then
  if [[ -x /usr/lib/postgresql/16/bin/initdb ]]; then
    PG_BIN=/usr/lib/postgresql/16/bin
  elif command -v pg_config >/dev/null 2>&1 && [[ -x "$(pg_config --bindir)/initdb" ]]; then
    PG_BIN="$(pg_config --bindir)"
  elif command -v initdb >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v initdb)")"
  else
    echo "PostgreSQL not found. Install PostgreSQL 16 or set PG_BIN to its bin directory." >&2
    exit 2
  fi
fi
for tool in initdb pg_ctl psql pg_dump; do
  if [[ ! -x "$PG_BIN/$tool" ]]; then
    echo "$PG_BIN/$tool not found. Set PG_BIN to a PostgreSQL bin directory." >&2
    exit 2
  fi
done
echo "Using $("$PG_BIN/postgres" --version 2>/dev/null || "$PG_BIN/initdb" --version)"

# 1. The migrations must not touch the app's tables or the auth schema, which exist only on
#    Supabase. Comments are ignored.
app_tables="$(grep -hoiE 'create table if not exists public\.[a-z_]+' "$root"/milk-crate/supabase/*.sql 2>/dev/null \
  | sed -E 's/.*public\.//I' | sort -u | paste -sd'|' - || true)"
code_only="$(sed -E 's/--.*$//' "$migrations"/*.sql)"
bad=""
if grep -qiE '\bauth\.' <<<"$code_only"; then bad+=" auth.*"; fi
if grep -oiE '\bpublic\.[a-z_]+' <<<"$code_only" | grep -viqE '^public\.api_'; then bad+=" public.<non-api table>"; fi
if [[ -n "$app_tables" ]] && grep -qiE "\b(from|join|into|update|references|table)[[:space:]]+($app_tables)\b" <<<"$code_only"; then
  bad+=" app table"
fi
if [[ -n "$bad" ]]; then
  echo "FAIL - db/migrations references Supabase-only objects:$bad" >&2
  exit 1
fi
echo "ok - db/migrations references no auth.* or app table"

# 2. A throwaway cluster. initdb refuses to run as root, so as root run it as postgres.
work="$(mktemp -d "${TMPDIR:-/tmp}/milk-crate-db-test.XXXXXX")"
as_pg() {
  if [[ "$(id -u)" -eq 0 ]]; then
    (cd "$work" && runuser -u postgres -- "$@")
  else
    (cd "$work" && "$@")
  fi
}
cleanup() {
  local status=$?
  if [[ -f "$work/data/postmaster.pid" ]]; then
    as_pg "$PG_BIN/pg_ctl" -D "$work/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ "$(id -u)" -eq 0 ]]; then
  chown postgres "$work"
fi

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port=""
for _ in $(seq 1 50); do
  candidate=$(( 20000 + RANDOM % 40000 ))
  if ! port_in_use "$candidate"; then port="$candidate"; break; fi
done
if [[ -z "$port" ]]; then
  echo "No free port found." >&2
  exit 2
fi

as_pg "$PG_BIN/initdb" -D "$work/data" -U postgres --auth=trust --encoding=UTF8 --no-locale >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$work/data" -l "$work/server.log" -w \
  -o "-p $port -k $work -c listen_addresses=127.0.0.1 -c fsync=off" start >/dev/null
echo "ok - temporary cluster on port $port"

run_psql() {
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d milk_crate_test "$@"
}
"$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d postgres \
  -c "create database milk_crate_test"

# 3. Every migration, twice. The second run must leave the schema exactly as the first.
shopt -s nullglob
files=("$migrations"/[0-9][0-9][0-9][0-9]_*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No migrations in $migrations" >&2
  exit 1
fi
for pass in 1 2; do
  for f in "${files[@]}"; do
    PGOPTIONS="-c client_min_messages=warning" run_psql --single-transaction -f "$f"
  done
  "$PG_BIN/pg_dump" -h 127.0.0.1 -p "$port" -U postgres --schema-only milk_crate_test \
    | grep -vE '^\\(un)?restrict ' >"$work/schema-$pass.sql"
  echo "ok - applied ${#files[@]} migrations (pass $pass)"
done
if ! diff -u "$work/schema-1.sql" "$work/schema-2.sql" >"$work/schema.diff"; then
  cat "$work/schema.diff" >&2
  echo "FAIL - the second run changed the schema" >&2
  exit 1
fi
echo "ok - the second run changed nothing"

# 4. The checks. Each prints "ok - ..."; the first failure stops the run.
run_psql -f "$here/checks.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE: +//'
echo "All database checks passed."

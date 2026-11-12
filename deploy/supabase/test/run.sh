#!/usr/bin/env bash
# Session E's tests: the Supabase modules against mocks at their HTTP edges, and the
# database parts against a throwaway local PostgreSQL 16 (session B's approach).
#
#   bash deploy/supabase/test/run.sh
#
# Installs the packages (npm ci) if needed, type-checks, starts a temporary cluster in a temp
# directory on a free port, loads C's test-only Supabase stand-in and a pg_cron stand-in, applies
# the stand-up SQL with the same script the stand-up uses (twice, and checks the second run
# changed nothing), runs every test, then stops the cluster and removes the directory, also
# when a test fails. No keys, no Docker, no network beyond the package install.
# Needs Node 22.18 or newer and PostgreSQL 16 server binaries (set PG_BIN to pick them).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
root="$(cd "$pkg/../.." && pwd)"

if [[ ! -d "$pkg/node_modules" ]]; then
  (cd "$pkg" && npm ci --no-audit --no-fund)
fi
(cd "$pkg" && npx tsc --noEmit)
echo "ok - deploy/supabase type-checks"

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

work="$(mktemp -d "${TMPDIR:-/tmp}/milk-crate-e-test.XXXXXX")"
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
if [[ "$(id -u)" -eq 0 ]]; then chown postgres "$work"; fi

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port=""
for _ in $(seq 1 50); do
  candidate=$(( 20000 + RANDOM % 40000 ))
  if ! port_in_use "$candidate"; then port="$candidate"; break; fi
done
[[ -n "$port" ]] || { echo "No free port found." >&2; exit 2; }

as_pg "$PG_BIN/initdb" -D "$work/data" -U postgres --auth=trust --encoding=UTF8 --no-locale >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$work/data" -l "$work/server.log" -w \
  -o "-p $port -k $work -c listen_addresses=127.0.0.1 -c fsync=off" start >/dev/null
echo "ok - temporary cluster on port $port"

url="postgresql://postgres@127.0.0.1:$port/milk_crate_e_test"
"$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d postgres -c "create database milk_crate_e_test"
psql_db() { PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" "$url" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_db -f "$root/db/test/supabase-standin.sql"
psql_db -f "$here/cron-standin.sql"
echo "ok - loaded the test-only Supabase and pg_cron stand-ins"

for pass in 1 2; do
  MC_DB_URL="$url" PSQL="$PG_BIN/psql" bash "$pkg/scripts/apply-sql.sh" >"$work/apply-$pass.log"
  "$PG_BIN/pg_dump" "$url" --schema-only | grep -vE '^\\(un)?restrict ' >"$work/schema-$pass.sql"
  echo "ok - stand-up SQL in one transaction (pass $pass): $(tail -n1 "$work/apply-$pass.log")"
done
if ! diff -u "$work/schema-1.sql" "$work/schema-2.sql" >"$work/schema.diff"; then
  cat "$work/schema.diff" >&2
  echo "FAIL - the second stand-up run changed the schema" >&2
  exit 1
fi
echo "ok - the second stand-up run changed nothing"

# The free project: MC_FILE_SIZE_LIMIT=50MiB sets the masters bucket to 50 MiB (covers stay at
# 20 MiB). Then back to the default for the tests.
MC_FILE_SIZE_LIMIT=50MiB MC_DB_URL="$url" PSQL="$PG_BIN/psql" bash "$pkg/scripts/apply-sql.sh" >/dev/null
limits="$(psql_db -At -c "select string_agg(id || '=' || coalesce(file_size_limit::text, 'none'), ' ' order by id) from storage.buckets where id like 'mc-%'")"
if [[ "$limits" != "mc-art=20971520 mc-masters=52428800 mc-streams=none" ]]; then
  echo "FAIL - with MC_FILE_SIZE_LIMIT=50MiB the buckets are: $limits" >&2
  exit 1
fi
MC_DB_URL="$url" PSQL="$PG_BIN/psql" bash "$pkg/scripts/apply-sql.sh" >/dev/null
echo "ok - MC_FILE_SIZE_LIMIT=50MiB sets the buckets for a free project ($limits)"

cd "$pkg"
MC_TEST_DB_URL="$url" node --test --test-reporter=spec --test-concurrency=1 test/*.test.ts
echo "All deploy/supabase tests passed."

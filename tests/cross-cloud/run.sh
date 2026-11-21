#!/usr/bin/env bash
# Session G's cross-cloud check: one scenario run on the Supabase module set (session E) and on
# the AWS module set (session F), compared step by step, plus session C's read-access fixture on
# both, the contract coverage check, and run-live.ts against the mocks.
#
#   bash tests/cross-cloud/run.sh
#
# Installs the packages (npm ci) of tests/cross-cloud/, deploy/supabase/ and deploy/aws/ if
# needed, type-checks, starts a throwaway PostgreSQL 16 cluster in a temp directory on a free
# port with two databases, each set up the way its deployment does it:
#   - Supabase: C's test-only Supabase stand-in and E's pg_cron stand-in, then E's own
#     scripts/apply-sql.sh (the app's SQL, db/migrations/, db/supabase/, deploy/supabase/sql/),
#     with MC_FILE_SIZE_LIMIT=50MiB as on the free project;
#   - AWS: db/migrations/ split into single statements through F's Data API path
#     (deploy/aws/test/apply-split.ts).
# Then it runs the tests, stops the cluster and removes the directory, also when a test fails.
# No keys, no Docker, no network beyond the package installs. Needs Node 22.18 or newer, ffmpeg
# and ffprobe (session H's processing step makes the streaming copies), and PostgreSQL 16 server
# binaries (set PG_BIN to pick them).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found. Install ffmpeg (it brings ffprobe)." >&2; exit 2; }
done

for dir in "$here" "$root/deploy/supabase" "$root/deploy/aws"; do
  if [[ ! -d "$dir/node_modules" ]]; then
    (cd "$dir" && npm ci --no-audit --no-fund)
  fi
done
# Each worker's wiring.ts (its hourly sweep, used for the takedown's late pass) imports the
# core from ../_core/, the uncommitted copy the deployments make: make it fresh, as
# worker/test/run.sh does.
bash "$root/deploy/supabase/scripts/copy-core.sh" >/dev/null
bash "$root/deploy/aws/scripts/copy-core.sh" >/dev/null
(cd "$here" && npx tsc --noEmit)
echo "ok - tests/cross-cloud type-checks"

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

work="$(mktemp -d "${TMPDIR:-/tmp}/milk-crate-g2-test.XXXXXX")"
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

base="postgresql://postgres@127.0.0.1:$port"
for name in mc_xc_supabase mc_xc_aws; do
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 "$base/postgres" -c "create database $name"
done
supabase_url="$base/mc_xc_supabase"
aws_url="$base/mc_xc_aws"

psql_sb() { PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" "$supabase_url" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_sb -f "$root/db/test/supabase-standin.sql"
psql_sb -f "$root/deploy/supabase/test/cron-standin.sql"
MC_FILE_SIZE_LIMIT=50MiB MC_DB_URL="$supabase_url" PSQL="$PG_BIN/psql" bash "$root/deploy/supabase/scripts/apply-sql.sh" >"$work/apply-supabase.log"
echo "ok - Supabase database: $(tail -n1 "$work/apply-supabase.log")"

echo "ok - AWS database through the Data API path: $(MC_SPLIT_DB_URL="$aws_url" node "$root/deploy/aws/test/apply-split.ts")"

cd "$here"
MC_XC_SUPABASE_DB_URL="$supabase_url" MC_XC_AWS_DB_URL="$aws_url" \
  node --test --test-reporter=spec --test-concurrency=1 test/*.test.ts
echo "All cross-cloud tests passed."

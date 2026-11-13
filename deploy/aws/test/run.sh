#!/usr/bin/env bash
# Session F's tests: the AWS modules against mocks at their SDK edges, the CDK stack
# synthesized offline, and the database parts against a throwaway local PostgreSQL 16
# (session B's approach) through a stand-in for the RDS Data API.
#
#   bash deploy/aws/test/run.sh
#
# Installs the packages (npm ci) if needed, type-checks, starts a temporary cluster in a temp
# directory on a free port, then:
#   - applies db/migrations/ twice the way the stand-up does (split into single statements,
#     each file in one Data API transaction) to one database, and twice whole with psql to
#     another, and checks the two schemas are the same;
#   - runs every test.
# Then it stops the cluster and removes the directory, also when a test fails.
# No keys, no AWS account, no Docker, no network beyond the package install.
# Needs Node 22.18 or newer and PostgreSQL 16 server binaries (set PG_BIN to pick them).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
root="$(cd "$pkg/../.." && pwd)"

if [[ ! -d "$pkg/node_modules" ]]; then
  (cd "$pkg" && npm ci --no-audit --no-fund)
fi
(cd "$pkg" && npx tsc --noEmit)
echo "ok - deploy/aws type-checks"

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

work="$(mktemp -d "${TMPDIR:-/tmp}/milk-crate-f-test.XXXXXX")"
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
for name in milk_crate_f_split milk_crate_f_whole; do
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 "$base/postgres" -c "create database $name"
done
split="$base/milk_crate_f_split"
whole="$base/milk_crate_f_whole"

for pass in 1 2; do
  echo "ok - db/migrations through the Data API path (pass $pass): $(MC_SPLIT_DB_URL="$split" node "$here/apply-split.ts")"
  for f in "$root"/db/migrations/*.sql; do
    PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" "$whole" -X -q -v ON_ERROR_STOP=1 -1 -f "$f"
  done
done
"$PG_BIN/pg_dump" "$split" --schema-only | grep -vE '^\\(un)?restrict ' >"$work/split.sql"
"$PG_BIN/pg_dump" "$whole" --schema-only | grep -vE '^\\(un)?restrict ' >"$work/whole.sql"
if ! diff -u "$work/whole.sql" "$work/split.sql" >"$work/schema.diff"; then
  cat "$work/schema.diff" >&2
  echo "FAIL - applying the split statements gave a different schema from applying each file whole" >&2
  exit 1
fi
echo "ok - split statements give the same schema as each file whole with psql ($(grep -c '^CREATE' "$work/whole.sql") CREATE statements)"

cd "$pkg"
MC_TEST_DB_URL="$split" node --test --test-reporter=spec --test-concurrency=1 test/*.test.ts
echo "All deploy/aws tests passed."

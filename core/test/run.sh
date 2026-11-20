#!/usr/bin/env bash
# Session G's handler tests: every operation in core/src/handlers/ against fake identity,
# storage, jobs, schedules and email, and session B's real SQL on a throwaway local
# PostgreSQL 16 (session B's approach).
#
#   bash core/test/run.sh
#
# Installs core/'s dev packages (npm ci) if needed, type-checks the handlers and the tests,
# starts a temporary cluster in a temp directory on a free port, applies db/migrations/, runs
# every test, then stops the cluster and removes the directory, also when a test fails.
# No keys, no Docker, no network beyond the package install.
# Needs Node 22.18 or newer (it runs the TypeScript directly) and PostgreSQL 16 server
# binaries (set PG_BIN to pick them).
#
# Set DENO to a deno binary to run the same test files on Deno as well, after Node:
#   DENO="$(command -v deno)" bash core/test/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
root="$(cd "$pkg/.." && pwd)"

if [[ ! -d "$pkg/node_modules/postgres" ]]; then
  (cd "$pkg" && npm ci --no-audit --no-fund)
fi
(cd "$pkg" && npx tsc --noEmit && npx tsc --noEmit -p test)
echo "ok - core/ and its tests type-check"

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

work="$(mktemp -d "${TMPDIR:-/tmp}/milk-crate-g-test.XXXXXX")"
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

url="postgresql://postgres@127.0.0.1:$port/milk_crate_g_test"
"$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d postgres -c "create database milk_crate_g_test"
for f in "$root"/db/migrations/*.sql; do
  PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" "$url" -X -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "ok - applied db/migrations/"

cd "$pkg"
MC_TEST_DB_URL="$url" node --test --test-reporter=spec --test-concurrency=1 test/*.test.ts
echo "ok - every test passed on Node $(node --version)"

if [[ -n "${DENO:-}" ]]; then
  # Deno runs node:test files under `deno test`. --no-check: the types were checked above.
  # Sloppy imports: core/src/platform/ imports without file extensions, as on the Edge Functions.
  NO_COLOR=1 MC_TEST_DB_URL="$url" "$DENO" test --quiet --no-check --unstable-sloppy-imports \
    --allow-env --allow-net --allow-read --allow-sys test/*.test.ts >"$work/deno.log" 2>&1 || {
    cat "$work/deno.log" >&2
    echo "FAIL - the tests on Deno" >&2
    exit 1
  }
  grep -E '^(ok|FAILED) \|' "$work/deno.log" || tail -n 5 "$work/deno.log"
  echo "ok - every test passed on $("$DENO" --version | head -n1)"
fi
echo "All core handler tests passed."

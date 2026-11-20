#!/usr/bin/env bash
# Session H's tests: the shared processing step, and one run of it through each platform's
# worker skeleton with that platform's storage fake.
#
#   bash worker/test/run.sh            # the usual tests
#   MC_SLOW=1 bash worker/test/run.sh  # also the slow one: a 2 GB WAV streamed through
#
# Installs the packages (npm ci) of worker/, deploy/supabase/ and deploy/aws/ if needed (the
# skeleton runs use those platforms' code), copies core/src/ and worker/src/ into each platform's
# build folder (scripts/copy-core.sh), type-checks, starts a throwaway PostgreSQL 16 cluster in a
# temp directory on a free port, applies db/migrations/, runs the tests, then stops the cluster and
# removes the directory, also when a test fails. No keys, no Docker, no network beyond the
# package installs. Needs Node 22.18 or newer, ffmpeg and ffprobe on PATH, and PostgreSQL 16
# server binaries (set PG_BIN to pick them).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
root="$(cd "$pkg/.." && pwd)"

for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found. Install ffmpeg (it brings ffprobe)." >&2; exit 2; }
done
echo "ok - $(ffmpeg -hide_banner -version | head -n1)"

for dir in "$pkg" "$root/deploy/supabase" "$root/deploy/aws"; do
  if [[ ! -d "$dir/node_modules" ]]; then
    (cd "$dir" && npm ci --no-audit --no-fund)
  fi
done
bash "$root/deploy/supabase/scripts/copy-core.sh" >/dev/null
bash "$root/deploy/aws/scripts/copy-core.sh" >/dev/null
(cd "$pkg" && npx tsc --noEmit)
echo "ok - worker/ and its tests type-check"

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

work="$(mktemp -d "${TMPDIR:-/tmp}/milk-crate-h-test.XXXXXX")"
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

url="postgresql://postgres@127.0.0.1:$port/milk_crate_h_test"
"$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d postgres -c "create database milk_crate_h_test"
for f in "$root"/db/migrations/*.sql; do
  PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" "$url" -X -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "ok - applied db/migrations/"

cd "$pkg"
MC_TEST_DB_URL="$url" node --test --test-reporter=spec --test-concurrency=1 test/*.test.ts
echo "All worker tests passed."

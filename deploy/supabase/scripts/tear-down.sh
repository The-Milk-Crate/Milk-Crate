#!/usr/bin/env bash
# Tears down what scripts/stand-up.sh made.
#
#   bash deploy/supabase/scripts/tear-down.sh                   # keeps the project and its tables
#   bash deploy/supabase/scripts/tear-down.sh --delete-project  # also deletes the whole project
#
# 1. Deletes the Edge Functions this folder deploys.
# 2. Removes the pending pg_cron runs (api_schedules, their mc_schedule:* jobs and the daily sweep).
# 3. Empties and deletes the three Phase 0 buckets (mc-masters, mc-streams, mc-art). The app's
#    buckets are not touched.
# 4. Destroys the Fly app (its machines, image and secrets).
# 5. With --delete-project: deletes the Supabase project, with every table and file in it.
#    Without it, the database objects stay (they hold data): the api_ tables, functions, the
#    hook and the account sync. The Edge Function secrets stay too; remove them with
#    `supabase secrets unset`.
#
# Settings, from your shell: SUPABASE_ACCESS_TOKEN, MC_SUPABASE_PROJECT_REF, MC_DB_URL with
# PGPASSWORD, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (for the buckets), FLY_API_TOKEN, MC_FLY_APP.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
delete_project=false
[[ "${1:-}" == "--delete-project" ]] && delete_project=true

missing=()
for tool in supabase psql flyctl node; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
for var in SUPABASE_ACCESS_TOKEN MC_SUPABASE_PROJECT_REF MC_DB_URL PGPASSWORD SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
           FLY_API_TOKEN MC_FLY_APP; do
  [[ -n "${!var:-}" ]] || missing+=("\$$var")
done
[[ ${#missing[@]} -eq 0 ]] || { echo "Missing: ${missing[*]}" >&2; exit 2; }
ref="$MC_SUPABASE_PROJECT_REF"

echo "This deletes the Phase 0 functions, schedules, buckets and files of project $ref and Fly app $MC_FLY_APP."
$delete_project && echo "It also DELETES THE WHOLE PROJECT $ref."
read -r -p "Type the project ref again to go on: " typed
[[ "$typed" == "$ref" ]] || { echo "Stopped."; exit 1; }
cd "$pkg"
[[ -d node_modules ]] || npm ci --no-audit --no-fund

echo "== 1. Edge Functions"
for dir in supabase/functions/*/; do
  name="$(basename "$dir")"
  [[ "$name" == _* || ! -f "$dir/index.ts" ]] && continue
  supabase functions delete "$name" --project-ref "$ref" || true
done

echo "== 2. pending schedules"
psql "$MC_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction <<'SQL'
select cron.unschedule(jobname) from cron.job where jobname like 'mc\_schedule:%' or jobname = 'mc_schedule_sweep';
delete from public.api_schedules;
SQL

echo "== 3. buckets"
node scripts/tear-down-storage.ts

echo "== 4. Fly"
flyctl apps destroy "$MC_FLY_APP" --yes || true

if $delete_project; then
  echo "== 5. project"
  supabase projects delete "$ref"
fi
echo "Done."

#!/usr/bin/env bash
# Stands up the Phase 0 Supabase deployment on an existing Supabase project and a Fly app.
# K Marcus runs it; nothing here holds a secret. Run from anywhere:
#
#   bash deploy/supabase/scripts/stand-up.sh
#
# What it does, in order (each step is safe to run again):
#   1. Checks the tools and settings, and asks you to type the project ref again.
#   2. Links the Supabase CLI to the project.
#   3. Applies the database in one transaction: the app's SQL if the project has none yet,
#      then db/migrations/, db/supabase/ and deploy/supabase/sql/ (scripts/apply-sql.sh).
#      This also turns on pg_cron and makes the three private buckets with their limits.
#   4. Pushes supabase/config.toml: the access token hook, token life (1 hour), the file
#      size limit (MC_FILE_SIZE_LIMIT). The hook is turned on only after its function exists (step 3).
#   5. Sets the Edge Function secrets from your secrets file.
#   6. Copies core/src/ into supabase/functions/_core/ and _core/ (scripts/copy-core.sh), then
#      deploys every Edge Function entry point: one, `api`, serving session G's router.
#   7. Fly: creates the app if needed, sets its secrets, builds and pushes the worker image,
#      and makes (or updates) the hourly sweep machine.
#   8. Runs the checks (scripts/confirm.sh).
#
# Needs: supabase (CLI 2.122.1, checked; another version only warns), Docker running (the CLI
# bundles the Edge Function in it, and that bundler checks supabase/functions/deno.lock; the
# script stops if it is not running; Docker Desktop works), psql (16 or newer), flyctl,
# node (22.18 or newer), npm.
#
# Settings, from your shell (never from the repository):
#   SUPABASE_ACCESS_TOKEN   a Supabase personal access token (CLI and Management API)
#   MC_SUPABASE_PROJECT_REF the Phase 0 project's ref
#   SUPABASE_DB_PASSWORD    the project's database password (read by the CLI)
#   PGPASSWORD              the same password (read by psql and the checks)
#   MC_DB_URL               the session pooler URL without the password, user postgres.<ref>:
#                           postgresql://postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432/postgres
#   MC_SITE_URL             Auth's site URL for this project (config.toml reads it)
#   MC_SECRETS_FILE         Edge Function secrets, NAME=value lines (see secrets.env.example)
#   FLY_API_TOKEN           a Fly token that may create apps and machines in MC_FLY_ORG
#   MC_FLY_APP, MC_FLY_ORG, MC_FLY_REGION
#   MC_FLY_SECRETS_FILE     the worker's secrets, NAME=value lines (see fly-secrets.env.example)
#   MC_FILE_SIZE_LIMIT      the project's file size limit: 50MiB on a free project (the Phase 0
#                           project, settled), 5GiB on Pro. Default 5GiB. Put the same value in
#                           MC_SECRETS_FILE, so uploads above it are refused in plain words.
#
# Plan: the Phase 0 project is a free project (settled), so files are capped at 50 MiB and the
# proof of concept uses small test masters. Masters up to 5 GiB need the Pro plan or higher.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"

missing=()
for tool in supabase docker psql flyctl node npm; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
for var in SUPABASE_ACCESS_TOKEN MC_SUPABASE_PROJECT_REF SUPABASE_DB_PASSWORD PGPASSWORD MC_DB_URL MC_SITE_URL \
           MC_SECRETS_FILE FLY_API_TOKEN MC_FLY_APP MC_FLY_ORG MC_FLY_REGION MC_FLY_SECRETS_FILE; do
  [[ -n "${!var:-}" ]] || missing+=("\$$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing: ${missing[*]}. See the top of this script." >&2
  exit 2
fi
# The Edge Function must be bundled in Docker: that bundler checks supabase/functions/deno.lock.
# Without Docker the CLI bundles on Supabase's servers instead, which was not checked.
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop (with WSL integration on, under WSL) and run this again." >&2
  exit 2
fi
# The Supabase CLI version these scripts were checked with (password rules, deno.lock).
cli_wanted="2.122.1"
cli_version="$(supabase --version 2>/dev/null | tr -d '[:space:]')"
if [[ "$cli_version" != "$cli_wanted" ]]; then
  echo "Warning: Supabase CLI $cli_version; these scripts were checked with $cli_wanted." >&2
  echo "Install it with: npm install -g supabase@$cli_wanted" >&2
fi
for f in "$MC_SECRETS_FILE" "$MC_FLY_SECRETS_FILE"; do
  [[ -f "$f" ]] || { echo "No file $f" >&2; exit 2; }
done
if [[ "$MC_DB_URL" =~ ://[^/@]*:[^/@]*@ ]]; then
  echo "Put the password in PGPASSWORD, not in MC_DB_URL." >&2
  exit 2
fi
export MC_FILE_SIZE_LIMIT="${MC_FILE_SIZE_LIMIT:-5GiB}"
if ! grep -q "^MC_FILE_SIZE_LIMIT=$MC_FILE_SIZE_LIMIT$" "$MC_SECRETS_FILE"; then
  echo "$MC_SECRETS_FILE must set MC_FILE_SIZE_LIMIT=$MC_FILE_SIZE_LIMIT, as your shell does." >&2
  exit 2
fi
ref="$MC_SUPABASE_PROJECT_REF"
app="$MC_FLY_APP"
image="registry.fly.io/$app:phase0"
if ! grep -q "^MC_FLY_WORKER_IMAGE=$image$" "$MC_SECRETS_FILE"; then
  echo "$MC_SECRETS_FILE must set MC_FLY_WORKER_IMAGE=$image" >&2
  exit 2
fi

echo "This changes Supabase project $ref (database, auth settings, storage, functions, secrets)"
echo "with a file size limit of $MC_FILE_SIZE_LIMIT."
echo "and Fly app $app. Pushing config.toml replaces the project's auth settings."
echo "Use the Phase 0 project, not the app's live project."
read -r -p "Type the project ref again to go on: " typed
[[ "$typed" == "$ref" ]] || { echo "Stopped."; exit 1; }

cd "$pkg"
[[ -d node_modules ]] || npm ci --no-audit --no-fund

echo "== 2. link"
supabase link --project-ref "$ref"

echo "== 3. database (one transaction)"
bash "$here/apply-sql.sh"

echo "== 4. auth and storage settings (config.toml)"
supabase config push --project-ref "$ref"

echo "== 5. Edge Function secrets"
supabase secrets set --project-ref "$ref" --env-file "$MC_SECRETS_FILE"

echo "== 6. Edge Functions"
# The function and the worker image hold copies of session G's core (see copy-core.sh).
bash scripts/copy-core.sh
deployed=0
for dir in supabase/functions/*/; do
  name="$(basename "$dir")"
  [[ "$name" == _* || ! -f "$dir/index.ts" ]] && continue
  supabase functions deploy "$name" --project-ref "$ref" --no-verify-jwt --import-map supabase/functions/deno.json
  deployed=$((deployed + 1))
done
echo "deployed $deployed Edge Functions"
[[ $deployed -gt 0 ]] || { echo "No Edge Function was deployed; expected supabase/functions/api." >&2; exit 1; }

echo "== 7. Fly worker"
if ! flyctl status --app "$app" >/dev/null 2>&1; then
  flyctl apps create "$app" --org "$MC_FLY_ORG"
fi
flyctl secrets import --app "$app" --stage <"$MC_FLY_SECRETS_FILE"
flyctl deploy --app "$app" --config fly/fly.toml --build-only --push --image-label phase0
sweep_id="$(flyctl machine list --app "$app" --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const m = (JSON.parse(s || "[]") || []).find((x) => x.name === "sweep");
    process.stdout.write(m ? m.id : "");
  });')"
if [[ -z "$sweep_id" ]]; then
  flyctl machine run "$image" --app "$app" --name sweep --region "$MC_FLY_REGION" \
    --schedule hourly --restart no --env MC_WORKER_MODE=sweep
else
  flyctl machine update "$sweep_id" --app "$app" --image "$image" --schedule hourly --yes
fi

echo "== 8. checks"
bash "$here/confirm.sh"

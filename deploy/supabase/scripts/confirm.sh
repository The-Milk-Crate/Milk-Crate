#!/usr/bin/env bash
# Checks a stood-up Phase 0 Supabase deployment and lists every problem in plain words.
#
#   bash deploy/supabase/scripts/confirm.sh
#
# Reads SUPABASE_ACCESS_TOKEN, MC_SUPABASE_PROJECT_REF, MC_DB_URL with PGPASSWORD,
# FLY_API_TOKEN, MC_FLY_APP and MC_FILE_SIZE_LIMIT (default 5GiB) from your shell. Read only: it changes nothing.
set -euo pipefail
pkg="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$pkg"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
node scripts/confirm.ts

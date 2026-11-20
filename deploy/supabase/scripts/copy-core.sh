#!/usr/bin/env bash
# Copies the shared core (core/src/) into the two places Supabase's builds can reach, fresh
# each time. Neither copy is committed (.gitignore).
#   - supabase/functions/_core/: the Edge Function imports the handlers from here. Supabase
#     deploys shared code from a folder starting with _ next to the functions, and its bundler
#     may not follow an import out of this project (deploy/supabase/) to core/.
#   - _core/: the worker image (build context deploy/supabase/) imports the job-result and
#     sweep functions from here.
# stand-up.sh and test/run.sh run this first; run it by hand before `npx tsc`.
#
#   bash deploy/supabase/scripts/copy-core.sh
set -euo pipefail
pkg="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$(cd "$pkg/../../core/src" && pwd)"
for dest in "$pkg/_core" "$pkg/supabase/functions/_core"; do
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$src/." "$dest/"
done
echo "copied core/src/ to deploy/supabase/_core/ and deploy/supabase/supabase/functions/_core/"

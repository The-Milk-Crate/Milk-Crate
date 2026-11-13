#!/usr/bin/env bash
# Checks a stood-up Phase 0 AWS deployment and lists every problem in plain words.
#
#   MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/confirm.sh
#
# Reads the stack's outputs (MC_OUTPUTS_FILE), and never reads a secret's value. Needs aws and node.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_tools aws node
load_settings
[[ -f "$MC_OUTPUTS_FILE" ]] || write_outputs
cd "$pkg"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
MC_OUTPUTS_FILE="$MC_OUTPUTS_FILE" node scripts/confirm.ts

#!/usr/bin/env bash
# Runs the account sync now: every Cognito user into the group their api_accounts row names
# (no group without a row or when suspended). It also runs every 15 minutes by itself.
# Run it after writing or changing api_accounts rows. With a Cognito sub, syncs one user.
#
#   MC_SETTINGS_FILE=... bash deploy/aws/scripts/sync-accounts.sh [<cognito sub>]
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_tools aws node
load_settings
[[ -f "$MC_OUTPUTS_FILE" ]] || write_outputs
payload='{}'
if [[ $# -gt 0 ]]; then
  [[ "$1" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "A user is given by their Cognito sub (a UUID)." >&2; exit 2; }
  payload="{\"userId\":\"$1\"}"
fi
result="$(mktemp)"
trap 'rm -f "$result"' EXIT
error="$(aws lambda invoke --function-name "$(output AccountSyncFunction)" --cli-binary-format raw-in-base64-out \
  --payload "$payload" "$result" --query FunctionError --output text)"
if [[ "$error" != "None" && -n "$error" ]]; then
  echo "account sync failed: $(cat "$result")" >&2
  exit 1
fi
echo "account sync: $(cat "$result")"

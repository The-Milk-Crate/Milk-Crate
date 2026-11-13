#!/usr/bin/env bash
# Tears the Phase 0 AWS deployment down: every file, the stack (database, users, API, worker,
# schedules and their one-time runs, queue, logs) and the two Milk Crate secrets. It cannot be
# undone. The CDK bootstrap stack (CDKToolkit) is left, as other CDK apps may use it.
#
#   MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/tear-down.sh
#
# Needs aws, node and npm. Asks you to type the account id and the region again.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_tools aws node npm
load_settings
confirm_target "This DELETES the Milk Crate Phase 0 stack and everything in it, including every file and the database:"
cd "$pkg"
[[ -d node_modules ]] || npm ci --no-audit --no-fund

if aws cloudformation describe-stacks --stack-name "$MC_STACK_NAME" >/dev/null 2>&1; then
  write_outputs
  echo "== files"
  MC_OUTPUTS_FILE="$MC_OUTPUTS_FILE" node scripts/empty-bucket.ts
  echo "== stack"
  # The stack needs its settings to synthesize; any values do for a delete.
  MC_EMAIL_DOMAIN="${MC_EMAIL_DOMAIN:-unused.invalid}" MC_EMAIL_FROM="${MC_EMAIL_FROM:-unused@unused.invalid}" \
    npx cdk destroy "$MC_STACK_NAME" --force
else
  echo "no stack $MC_STACK_NAME"
fi

echo "== secrets"
# Without recovery, so a later stand-up can use the same names at once.
for id in milk-crate/phase0/MC_CLOUDFRONT_PRIVATE_KEY milk-crate/phase0/database; do
  if aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
    aws secretsmanager delete-secret --secret-id "$id" --force-delete-without-recovery >/dev/null
    echo "deleted $id"
  fi
done
rm -f "$MC_OUTPUTS_FILE"
echo "Torn down."

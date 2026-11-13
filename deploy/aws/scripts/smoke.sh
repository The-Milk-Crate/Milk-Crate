#!/usr/bin/env bash
# The smoke test: checks the stood-up AWS deployment for what the mocked tests could not.
# Run it after stand-up.sh (and after confirm.sh passes). It takes about 10 minutes.
#
#   MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/smoke.sh
#
# It checks, against the real services:
#   - the Data API: `:p1::uuid` parameters, the shapes of timestamptz, date, numeric, bigint
#     and jsonb, session B's MC404 error text, and a rolled-back transaction;
#   - S3: presigned parts with no part checksum on a full-object CRC64NVME upload, resume, a
#     wrong CRC64NVME (refused, upload stays open), the right one, a repeat confirm, readHead;
#   - CloudFront: signed cookies read one track's streaming copy, and not another track's, not
#     without cookies, and never a master;
#   - Cognito: a real access token checked against the pool's JWKS, the claim following
#     api_accounts through the sync, and a suspended row giving end_user;
#   - EventBridge Scheduler: a run calls the Data API and deletes itself; a failed run lands in
#     the dead-letter queue (it prints what the message carries);
#   - Fargate: two starts for one job id make one task, and the worker image runs and exits 0;
#   - SES: one email, only if MC_SMOKE_EMAIL_TO is set (in SES's sandbox, a verified address).
#
# It writes only test data under fresh random ids (a test user smoke-<id>@example.invalid, an
# api_accounts row, files under masters/ and streams/ of a made-up artist and release, two
# schedules, one worker task) and removes all of it at the end, also when a check fails.
# Set MC_SMOKE_SKIP_WORKER=1 to skip the Fargate check (it takes a few minutes).
# Needs aws and node, and the same AWS credentials as the stand-up.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_tools aws node
load_settings
confirm_target "This runs the smoke test against the Milk Crate Phase 0 stack (test data only, removed at the end):"
write_outputs
cd "$pkg"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
MC_OUTPUTS_FILE="$MC_OUTPUTS_FILE" node scripts/smoke.ts

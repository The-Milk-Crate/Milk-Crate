#!/usr/bin/env bash
# Shows schedule runs that failed (EventBridge Scheduler put them in the dead-letter queue with
# their error). Read only: the messages stay in the queue (kept 14 days) until you purge it.
#
#   MC_SETTINGS_FILE=... bash deploy/aws/scripts/failed-runs.sh
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need_tools aws node
load_settings
[[ -f "$MC_OUTPUTS_FILE" ]] || write_outputs
aws sqs receive-message --queue-url "$(output DeadLetterQueueUrl)" --max-number-of-messages 10 \
  --visibility-timeout 0 --message-attribute-names All --attribute-names SentTimestamp --output json

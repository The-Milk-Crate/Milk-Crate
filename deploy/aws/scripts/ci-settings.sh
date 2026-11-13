#!/usr/bin/env bash
# For the aws-sandbox workflow only. Writes the stand-up's settings file and a fresh CloudFront
# key pair into a private folder outside the repository, from the aws-sandbox environment's
# variables, and prints the settings file's path. Nothing here is secret except the private key,
# which never leaves the runner except into Secrets Manager (and tear-down deletes it there).
#
#   MC_SETTINGS_FILE="$(bash deploy/aws/scripts/ci-settings.sh <folder outside the repo>)"
#
# Needs MC_AWS_ACCOUNT, MC_AWS_REGION and MC_EMAIL_DOMAIN. Optional: MC_EMAIL_FROM (default
# noreply@MC_EMAIL_DOMAIN), MC_STACK_NAME (default MilkCratePhase0).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

dir="$(realpath -m "${1:?give a folder outside the repository}")"
case "$dir/" in "$root"/*) echo "$dir is inside the repository." >&2; exit 2 ;; esac
missing=()
for var in MC_AWS_ACCOUNT MC_AWS_REGION MC_EMAIL_DOMAIN; do [[ -n "${!var:-}" ]] || missing+=("$var"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Set these as variables of the aws-sandbox environment: ${missing[*]}" >&2
  exit 2
fi
[[ "$MC_EMAIL_DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "MC_EMAIL_DOMAIN looks wrong." >&2; exit 2; }

umask 077
mkdir -p "$dir"
openssl genrsa -out "$dir/cloudfront-private.pem" 2048 2>/dev/null
openssl rsa -in "$dir/cloudfront-private.pem" -pubout -out "$dir/cloudfront-public.pem" 2>/dev/null
cat >"$dir/aws.settings.env" <<SETTINGS
MC_AWS_ACCOUNT=$MC_AWS_ACCOUNT
MC_AWS_REGION=$MC_AWS_REGION
MC_STACK_NAME=${MC_STACK_NAME:-MilkCratePhase0}
MC_EMAIL_DOMAIN=$MC_EMAIL_DOMAIN
MC_EMAIL_FROM=${MC_EMAIL_FROM:-Milk Crate <noreply@$MC_EMAIL_DOMAIN>}
MC_CLOUDFRONT_PUBLIC_KEY_FILE=$dir/cloudfront-public.pem
MC_CLOUDFRONT_PRIVATE_KEY_FILE=$dir/cloudfront-private.pem
MC_OUTPUTS_FILE=$dir/outputs.json
SETTINGS
echo "$dir/aws.settings.env"

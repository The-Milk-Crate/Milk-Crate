#!/usr/bin/env bash
# Stands up the Phase 0 AWS deployment in one AWS account and region. K Marcus runs it;
# nothing here holds a secret. Run from anywhere:
#
#   MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/stand-up.sh
#
# What it does, in order (each step is safe to run again):
#   1. Checks the tools and settings, checks your AWS credentials are for MC_AWS_ACCOUNT, and
#      asks you to type the account id and the region again.
#   2. Installs the packages (npm ci).
#   3. Bootstraps CDK in the account and region (once; a no-op after).
#   4. Puts the CloudFront private key in Secrets Manager (milk-crate/phase0/MC_CLOUDFRONT_PRIVATE_KEY),
#      after checking it matches the public key. The key is read from its file, never printed.
#   5. Deploys the stack (infra/stack.ts): Aurora with the Data API, Cognito and its groups,
#      the bucket, CloudFront and its key group, the API, the Lambdas, the Fargate worker
#      image, the schedules, the dead-letter queue, SES and IAM. It shows IAM changes first.
#   6. Writes the stack's outputs to MC_OUTPUTS_FILE.
#   7. Applies db/migrations/ (never db/supabase/) through the Data API, each file whole in
#      one transaction (scripts/apply-migrations.ts).
#   8. Runs the account sync once (Cognito groups from api_accounts).
#   9. Prints the DNS records SES needs, then runs the checks (scripts/confirm.sh).
#
# Needs: aws (CLI v2, signed in: AWS_PROFILE or your default credentials), node (22.18 or
# newer), npm, docker (CDK builds the worker image), openssl.
# Settings: MC_SETTINGS_FILE, outside the repository (see settings.env.example).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

need_tools aws node npm docker openssl
load_settings MC_EMAIL_DOMAIN MC_EMAIL_FROM MC_CLOUDFRONT_PUBLIC_KEY_FILE MC_CLOUDFRONT_PRIVATE_KEY_FILE
for f in "$MC_CLOUDFRONT_PUBLIC_KEY_FILE" "$MC_CLOUDFRONT_PRIVATE_KEY_FILE"; do
  [[ -f "$f" ]] || { echo "No file $f" >&2; exit 2; }
  outside_repo "$f"
done
if ! diff -q <(openssl rsa -in "$MC_CLOUDFRONT_PRIVATE_KEY_FILE" -pubout 2>/dev/null) <(openssl rsa -pubin -in "$MC_CLOUDFRONT_PUBLIC_KEY_FILE" -pubout 2>/dev/null) >/dev/null; then
  echo "The CloudFront private and public key files do not match." >&2
  exit 2
fi

confirm_target "This creates or changes the Milk Crate Phase 0 stack (database, users, files, API, worker, email):"

cd "$pkg"
echo "== 2. packages"
npm ci --no-audit --no-fund

echo "== 3. CDK bootstrap"
npx cdk bootstrap "aws://$MC_AWS_ACCOUNT/$MC_AWS_REGION"

echo "== 4. CloudFront private key -> Secrets Manager"
key_secret="milk-crate/phase0/MC_CLOUDFRONT_PRIVATE_KEY"
if aws secretsmanager describe-secret --secret-id "$key_secret" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$key_secret" --secret-string "file://$MC_CLOUDFRONT_PRIVATE_KEY_FILE" >/dev/null
else
  aws secretsmanager create-secret --name "$key_secret" --description "Milk Crate Phase 0: CloudFront signed cookie key" \
    --secret-string "file://$MC_CLOUDFRONT_PRIVATE_KEY_FILE" >/dev/null
fi
echo "stored $key_secret"

echo "== 5. deploy"
npx cdk deploy "$MC_STACK_NAME" --require-approval broadening

echo "== 6. outputs -> $MC_OUTPUTS_FILE"
write_outputs

echo "== 7. db/migrations (Data API)"
MC_OUTPUTS_FILE="$MC_OUTPUTS_FILE" node scripts/apply-migrations.ts

echo "== 8. account sync"
bash "$here/sync-accounts.sh"

echo "== 9. SES DNS records and checks"
echo "Add these CNAME records to $MC_EMAIL_DOMAIN's DNS (SES verifies the domain from them):"
for token in $(aws sesv2 get-email-identity --email-identity "$MC_EMAIL_DOMAIN" --query "DkimAttributes.Tokens" --output text); do
  echo "  ${token}._domainkey.$MC_EMAIL_DOMAIN  CNAME  ${token}.dkim.amazonses.com"
done
echo "New SES accounts are in a sandbox and send only to verified addresses; ask AWS for production access."
bash "$here/confirm.sh" || echo "Some checks failed (see above). Fix them and run confirm.sh again."

import { test } from "node:test";
import assert from "node:assert/strict";
import { DescribeUserPoolCommand, ListGroupsCommand } from "@aws-sdk/client-cognito-identity-provider";
import { GetBucketCorsCommand, GetBucketLifecycleConfigurationCommand, GetBucketVersioningCommand, GetPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { GetDistributionCommand, GetKeyGroupCommand } from "@aws-sdk/client-cloudfront";
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetAccountCommand, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import { DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { GetScheduleCommand, GetScheduleGroupCommand } from "@aws-sdk/client-scheduler";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import type { Database } from "../src/core.ts";
import { awsInfrastructure, confirmDeployment, type DeploymentFacts } from "../src/infrastructure.ts";
import { COGNITO_GROUPS } from "../src/identity.ts";
import { FakeAws, awsError } from "./fake-aws.ts";

const FACTS: DeploymentFacts = {
  userPoolId: "pool", bucket: "files", distributionId: "D1", keyGroupId: "KG", keyPairId: "K1", emailDomain: "example.invalid",
  taskDefinition: "td", scheduleGroup: "milk-crate-phase0", sweepSchedule: "mc-worker-sweep", accountSyncSchedule: "mc-account-sync",
  deadLetterQueueUrl: "https://sqs/q",
};

function healthy(over: { db?: Record<string, boolean>; groups?: { GroupName: string; Precedence: number }[]; dlq?: string; behaviours?: string[] } = {}) {
  const signed = { TrustedKeyGroups: { Enabled: true, Items: ["KG"] } };
  const database: Database = {
    async query<Row>() { return [{ migrations: true, jobs: true, go_live: true, supabase_only: false, ...(over.db ?? {}) }] as Row[]; },
    async transaction(fn) { return fn(database); },
  };
  return {
    facts: FACTS,
    database,
    cognito: new FakeAws()
      .on(DescribeUserPoolCommand, () => ({ UserPool: { LambdaConfig: { PostConfirmation: "arn:fn" } } }))
      .on(ListGroupsCommand, () => ({ Groups: over.groups ?? COGNITO_GROUPS.map((g) => ({ GroupName: g.name, Precedence: g.precedence })) })),
    s3: new FakeAws()
      .on(GetPublicAccessBlockCommand, () => ({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } }))
      .on(GetBucketVersioningCommand, () => ({}))
      .on(GetBucketLifecycleConfigurationCommand, () => ({ Rules: [{ Status: "Enabled", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }] }))
      .on(GetBucketCorsCommand, () => ({ CORSRules: [{ AllowedMethods: ["PUT"], ExposeHeaders: ["ETag"] }] })),
    cloudFront: new FakeAws()
      .on(GetDistributionCommand, () => ({
        Distribution: {
          Status: "Deployed",
          DistributionConfig: {
            Enabled: true,
            DefaultCacheBehavior: signed,
            CacheBehaviors: { Items: (over.behaviours ?? ["streams/*", "art/*"]).map((PathPattern) => ({ PathPattern, ...signed })) },
          },
        },
      }))
      .on(GetKeyGroupCommand, () => ({ KeyGroup: { KeyGroupConfig: { Items: ["K1"] } } })),
    secrets: new FakeAws().on(DescribeSecretCommand, () => ({ Name: "x" })),
    ses: new FakeAws().on(GetEmailIdentityCommand, () => ({ VerifiedForSendingStatus: true })).on(GetAccountCommand, () => ({ ProductionAccessEnabled: true })),
    ecs: new FakeAws().on(DescribeTaskDefinitionCommand, () => ({})),
    scheduler: new FakeAws().on(GetScheduleGroupCommand, () => ({})).on(GetScheduleCommand, () => ({ State: "ENABLED" })),
    sqs: new FakeAws().on(GetQueueAttributesCommand, () => ({ Attributes: { ApproximateNumberOfMessages: over.dlq ?? "0" } })),
  };
}

test("a healthy deployment has no problems, and confirm never reads a secret's value", async () => {
  const options = healthy();
  assert.deepEqual(await confirmDeployment(options), { ok: true, problems: [] });
  assert.equal(options.secrets.inputs(GetSecretValueCommand).length, 0);
  assert.equal(options.secrets.inputs(DescribeSecretCommand)[0].SecretId, "milk-crate/phase0/MC_CLOUDFRONT_PRIVATE_KEY");
});

test("every problem is listed in plain words", async () => {
  const options = healthy({
    db: { migrations: false, supabase_only: true },
    groups: [{ GroupName: "administrator", Precedence: 3 }, { GroupName: "end_user", Precedence: 9 }],
    dlq: "2",
    behaviours: ["streams/*"],
  });
  options.secrets.on(DescribeSecretCommand, () => { throw awsError("ResourceNotFoundException"); });
  options.ses.on(GetAccountCommand, () => ({ ProductionAccessEnabled: false }));
  options.s3.on(GetBucketVersioningCommand, () => ({ Status: "Enabled" }));
  options.scheduler.on(GetScheduleCommand, (i) => { if (i.Name === "mc-worker-sweep") throw awsError("ResourceNotFoundException"); return { State: "DISABLED" }; });
  const { ok, problems } = await confirmDeployment(options);
  assert.equal(ok, false);
  assert.deepEqual(problems, [
    "db/migrations are not applied (run the stand-up again)",
    "db/supabase was applied to Aurora; it is Supabase-only",
    "Cognito group administrator has precedence 3, want 1",
    "Cognito group internal is missing",
    "Cognito group internal_accounting is missing",
    "Cognito group third_party is missing",
    "Cognito group artist is missing",
    "there is an end_user Cognito group; no group means end_user",
    "bucket files has versioning on, so takedown would leave old versions",
    "CloudFront has no behaviour for art/*",
    "the secret MC_CLOUDFRONT_PRIVATE_KEY (the CloudFront private key) is missing",
    "SES is in its sandbox: it sends only to verified addresses until production access is granted",
    "the schedule mc-worker-sweep is missing",
    "the schedule mc-account-sync is not enabled",
    "2 failed schedule runs are waiting in the dead-letter queue (read them with scripts/failed-runs.sh)",
  ]);
});

test("an unreachable service is a problem, not a crash", async () => {
  const options = healthy();
  options.cloudFront.on(GetDistributionCommand, () => { throw awsError("AccessDenied", "not allowed"); });
  const { problems } = await confirmDeployment(options);
  assert.deepEqual(problems, ["cloudfront: AccessDenied not allowed"]);
});

test("Infrastructure runs the stand-up and tear-down scripts", async () => {
  const ran: string[] = [];
  const infra = awsInfrastructure({ run: async (s) => { ran.push(s); }, confirm: async () => ({ ok: true, problems: [] }) });
  await infra.standUp();
  await infra.tearDown();
  assert.deepEqual(ran, ["scripts/stand-up.sh", "scripts/tear-down.sh"]);
});

import { DescribeUserPoolCommand, ListGroupsCommand } from "@aws-sdk/client-cognito-identity-provider";
import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { GetDistributionCommand, GetKeyGroupCommand } from "@aws-sdk/client-cloudfront";
import { DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import { GetAccountCommand, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import { DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { GetScheduleCommand, GetScheduleGroupCommand } from "@aws-sdk/client-scheduler";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import type { Database, Infrastructure } from "./core.ts";
import { errorName, type Sender } from "./aws.ts";
import { COGNITO_GROUPS } from "./identity.ts";
import { UPLOAD_DAYS } from "./storage.ts";
import { CLOUDFRONT_KEY_SECRET } from "./modules.ts";

/** What the stack's outputs say was stood up (scripts/outputs.ts reads them). */
export interface DeploymentFacts {
  userPoolId: string;
  bucket: string;
  distributionId: string;
  keyGroupId: string;
  keyPairId: string;
  emailDomain: string;
  taskDefinition: string;
  scheduleGroup: string;
  sweepSchedule: string;
  accountSyncSchedule: string;
  deadLetterQueueUrl: string;
  secretPrefix?: string;
}

export interface ConfirmOptions {
  facts: DeploymentFacts;
  database: Database;
  cognito: Sender;
  s3: Sender;
  cloudFront: Sender;
  secrets: Sender;
  ses: Sender;
  ecs: Sender;
  scheduler: Sender;
  sqs: Sender;
}

/** Checks a stood-up deployment. Returns every problem found, in plain words, as on session E. */
export async function confirmDeployment(options: ConfirmOptions): Promise<{ ok: boolean; problems: string[] }> {
  const { facts } = options;
  const problems: string[] = [];
  const check = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${errorName(error) || "error"} ${(error as Error)?.message ?? ""}`.trim());
    }
  };

  await check("database", async () => {
    const [found] = await options.database.query<Record<string, boolean>>(
      `select to_regclass('public.api_releases') is not null as migrations,
              to_regclass('public.api_jobs') is not null as jobs,
              to_regprocedure('public.api_release_go_live(uuid)') is not null as go_live,
              to_regprocedure('public.api_access_token_hook(jsonb)') is not null as supabase_only`,
    );
    if (!found.migrations || !found.jobs || !found.go_live) problems.push("db/migrations are not applied (run the stand-up again)");
    if (found.supabase_only) problems.push("db/supabase was applied to Aurora; it is Supabase-only");
  });

  await check("cognito", async () => {
    const pool = await options.cognito.send(new DescribeUserPoolCommand({ UserPoolId: facts.userPoolId }));
    if (!pool.UserPool?.LambdaConfig?.PostConfirmation) problems.push("the Cognito post-confirmation trigger is not set");
    const out = await options.cognito.send(new ListGroupsCommand({ UserPoolId: facts.userPoolId, Limit: 60 }));
    const groups = new Map<string, number | undefined>(
      (out.Groups ?? []).map((g: { GroupName?: string; Precedence?: number }) => [g.GroupName ?? "", g.Precedence]),
    );
    for (const g of COGNITO_GROUPS) {
      if (!groups.has(g.name)) problems.push(`Cognito group ${g.name} is missing`);
      else if (groups.get(g.name) !== g.precedence) {
        problems.push(`Cognito group ${g.name} has precedence ${String(groups.get(g.name))}, want ${g.precedence}`);
      }
    }
    if (groups.has("end_user")) problems.push("there is an end_user Cognito group; no group means end_user");
  });

  await check("s3", async () => {
    const block = await options.s3.send(new GetPublicAccessBlockCommand({ Bucket: facts.bucket }));
    const c = block.PublicAccessBlockConfiguration ?? {};
    if (!(c.BlockPublicAcls && c.BlockPublicPolicy && c.IgnorePublicAcls && c.RestrictPublicBuckets)) {
      problems.push(`bucket ${facts.bucket} does not block all public access`);
    }
    const versioning = await options.s3.send(new GetBucketVersioningCommand({ Bucket: facts.bucket }));
    if (versioning.Status === "Enabled") problems.push(`bucket ${facts.bucket} has versioning on, so takedown would leave old versions`);
    const life = await options.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: facts.bucket }));
    const abort = (life.Rules ?? []).find(
      (r: { Status?: string; AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number } }) =>
        r.Status === "Enabled" && r.AbortIncompleteMultipartUpload?.DaysAfterInitiation === UPLOAD_DAYS,
    );
    if (!abort) problems.push(`bucket ${facts.bucket} has no rule to abort unfinished uploads after ${UPLOAD_DAYS} days`);
    const cors = await options.s3.send(new GetBucketCorsCommand({ Bucket: facts.bucket }));
    const put = (cors.CORSRules ?? []).find(
      (r: { AllowedMethods?: string[]; ExposeHeaders?: string[] }) =>
        r.AllowedMethods?.includes("PUT") && r.ExposeHeaders?.some((h) => h.toLowerCase() === "etag"),
    );
    if (!put) problems.push(`bucket ${facts.bucket} CORS does not allow PUT with the ETag header exposed`);
  });

  await check("cloudfront", async () => {
    const out = await options.cloudFront.send(new GetDistributionCommand({ Id: facts.distributionId }));
    const d = out.Distribution;
    const config = d?.DistributionConfig;
    if (!config?.Enabled) problems.push(`CloudFront distribution ${facts.distributionId} is not enabled`);
    if (d?.Status !== "Deployed") problems.push(`CloudFront distribution ${facts.distributionId} is ${String(d?.Status)}, not Deployed`);
    const behaviours = [config?.DefaultCacheBehavior, ...(config?.CacheBehaviors?.Items ?? [])];
    for (const b of behaviours) {
      const path = (b as { PathPattern?: string })?.PathPattern ?? "default";
      const groups = b?.TrustedKeyGroups;
      if (!groups?.Enabled || !groups.Items?.includes(facts.keyGroupId)) {
        problems.push(`CloudFront behaviour ${path} does not require cookies from key group ${facts.keyGroupId}`);
      }
    }
    for (const want of ["streams/*", "art/*"]) {
      if (!(config?.CacheBehaviors?.Items ?? []).some((b: { PathPattern?: string }) => b.PathPattern === want)) {
        problems.push(`CloudFront has no behaviour for ${want}`);
      }
    }
    const group = await options.cloudFront.send(new GetKeyGroupCommand({ Id: facts.keyGroupId }));
    if (!group.KeyGroup?.KeyGroupConfig?.Items?.includes(facts.keyPairId)) {
      problems.push(`CloudFront key group ${facts.keyGroupId} does not hold public key ${facts.keyPairId}`);
    }
  });

  await check("secrets", async () => {
    // Describe only: confirm never reads a secret's value.
    try {
      await options.secrets.send(new DescribeSecretCommand({ SecretId: `${facts.secretPrefix ?? "milk-crate/phase0/"}${CLOUDFRONT_KEY_SECRET}` }));
    } catch (error) {
      if (errorName(error) === "ResourceNotFoundException") {
        problems.push(`the secret ${CLOUDFRONT_KEY_SECRET} (the CloudFront private key) is missing`);
        return;
      }
      throw error;
    }
  });

  await check("ses", async () => {
    const identity = await options.ses.send(new GetEmailIdentityCommand({ EmailIdentity: facts.emailDomain }));
    if (!identity.VerifiedForSendingStatus) problems.push(`SES has not verified ${facts.emailDomain} yet (add its DNS records)`);
    const account = await options.ses.send(new GetAccountCommand({}));
    if (!account.ProductionAccessEnabled) {
      problems.push("SES is in its sandbox: it sends only to verified addresses until production access is granted");
    }
  });

  await check("worker", async () => {
    await options.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: facts.taskDefinition }));
  });

  await check("schedules", async () => {
    await options.scheduler.send(new GetScheduleGroupCommand({ Name: facts.scheduleGroup }));
    for (const name of [facts.sweepSchedule, facts.accountSyncSchedule]) {
      try {
        const s = await options.scheduler.send(new GetScheduleCommand({ Name: name, GroupName: facts.scheduleGroup }));
        if (s.State !== "ENABLED") problems.push(`the schedule ${name} is not enabled`);
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") problems.push(`the schedule ${name} is missing`);
        else throw error;
      }
    }
    const q = await options.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: facts.deadLetterQueueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
    );
    const failed = Number(q.Attributes?.ApproximateNumberOfMessages ?? 0);
    if (failed > 0) problems.push(`${failed} failed schedule runs are waiting in the dead-letter queue (read them with scripts/failed-runs.sh)`);
  });

  return { ok: problems.length === 0, problems };
}

/** Runs a script with the caller's environment. */
export type RunScript = (script: string, args: string[]) => Promise<void>;

/** `Infrastructure`: the stand-up and tear-down scripts, and the checks above. */
export function awsInfrastructure(options: {
  run: RunScript;
  confirm: () => Promise<{ ok: boolean; problems: string[] }>;
}): Infrastructure {
  return {
    standUp: () => options.run("scripts/stand-up.sh", []),
    confirm: options.confirm,
    tearDown: () => options.run("scripts/tear-down.sh", []),
  };
}

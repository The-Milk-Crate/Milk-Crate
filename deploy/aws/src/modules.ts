import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { ECSClient } from "@aws-sdk/client-ecs";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { Database, Modules } from "./core.ts";
import { list, required, type Env } from "./env.ts";
import { dataApiDatabase } from "./database.ts";
import { cognitoIdentity } from "./identity.ts";
import { s3Storage, type SignCookies } from "./storage.ts";
import { awsJobs, type ApplyJobResult } from "./jobs.ts";
import { fargateWorker } from "./fargate.ts";
import { eventBridgeSchedules } from "./schedules.ts";
import { awsSecretsAndEmail } from "./secrets-email.ts";

/** The secret (under milk-crate/phase0/) that holds the CloudFront private key, PEM. */
export const CLOUDFRONT_KEY_SECRET = "MC_CLOUDFRONT_PRIVATE_KEY";

/** The S3 client for uploads. Checksums only when S3 requires them, so presigned part URLs carry none. */
export function s3Client(region: string): S3Client {
  return new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
}

/** The Data API database from the environment (MC_DB_CLUSTER_ARN, MC_DB_SECRET_ARN, MC_DB_NAME). */
export function databaseFromEnv(env: Env): Database {
  const region = required(env, "AWS_REGION");
  return dataApiDatabase({
    client: new RDSDataClient({ region }),
    resourceArn: required(env, "MC_DB_CLUSTER_ARN"),
    secretArn: required(env, "MC_DB_SECRET_ARN"),
    database: env("MC_DB_NAME") || "milk_crate",
  });
}

/**
 * Every module from the environment. The CDK stack sets these on each Lambda and on the
 * worker task (infra/stack.ts); AWS_REGION is set by Lambda and Fargate themselves. No secret
 * is in the environment: the database login and the CloudFront private key are in Secrets
 * Manager and read when needed.
 */
export function createAwsModules(env: Env, extra: { applyJobResult?: ApplyJobResult } = {}): Modules {
  const region = required(env, "AWS_REGION");
  const database = databaseFromEnv(env);
  const s3 = s3Client(region);
  const secretsAndEmail = awsSecretsAndEmail({
    secrets: new SecretsManagerClient({ region }),
    ses: new SESv2Client({ region }),
    prefix: env("MC_SECRET_PREFIX") || undefined,
    from: env("MC_EMAIL_FROM") || "",
    configurationSet: env("MC_SES_CONFIGURATION_SET") || undefined,
  });
  const ttl = Number(env("MC_READ_TTL_SECONDS") || 600);
  const worker = env("MC_ECS_CLUSTER")
    ? fargateWorker({
        ecs: new ECSClient({ region }),
        cluster: required(env, "MC_ECS_CLUSTER"),
        taskDefinition: required(env, "MC_ECS_TASK_DEFINITION"),
        container: env("MC_ECS_CONTAINER") || "worker",
        subnets: list(env, "MC_ECS_SUBNETS"),
        securityGroups: list(env, "MC_ECS_SECURITY_GROUPS"),
      })
    : undefined;
  return {
    database,
    identity: cognitoIdentity({
      region,
      userPoolId: required(env, "MC_COGNITO_USER_POOL_ID"),
      clientIds: list(env, "MC_COGNITO_CLIENT_IDS"),
    }),
    storage: s3Storage({
      s3,
      presign: (command, expiresIn) => getSignedUrl(s3, command, { expiresIn }),
      bucket: required(env, "MC_BUCKET"),
      cloudFront: {
        domain: required(env, "MC_CLOUDFRONT_DOMAIN"),
        keyPairId: required(env, "MC_CLOUDFRONT_KEY_PAIR_ID"),
        privateKey: () => secretsAndEmail.getSecret(CLOUDFRONT_KEY_SECRET),
        signCookies: getSignedCookies as unknown as SignCookies,
      },
      readTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 600,
    }),
    jobs: awsJobs({ database, worker, applyResult: extra.applyJobResult }),
    schedules: eventBridgeSchedules({
      scheduler: new SchedulerClient({ region }),
      database,
      group: required(env, "MC_SCHEDULE_GROUP"),
      roleArn: required(env, "MC_SCHEDULER_ROLE_ARN"),
      deadLetterArn: required(env, "MC_SCHEDULER_DLQ_ARN"),
      resourceArn: required(env, "MC_DB_CLUSTER_ARN"),
      secretArn: required(env, "MC_DB_SECRET_ARN"),
      databaseName: env("MC_DB_NAME") || "milk_crate",
    }),
    secretsAndEmail,
  };
}

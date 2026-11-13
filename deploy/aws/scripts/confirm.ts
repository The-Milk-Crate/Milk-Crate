// The checks behind confirm.sh: Infrastructure.confirm against the real deployment.
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SQSClient } from "@aws-sdk/client-sqs";
import { dataApiDatabase } from "../src/database.ts";
import { confirmDeployment } from "../src/infrastructure.ts";
import { get, readOutputs, region } from "./outputs.ts";

const o = readOutputs();
const r = region();
const result = await confirmDeployment({
  facts: {
    userPoolId: get(o, "UserPoolId"),
    bucket: get(o, "Bucket"),
    distributionId: get(o, "DistributionId"),
    keyGroupId: get(o, "KeyGroupId"),
    keyPairId: get(o, "KeyPairId"),
    emailDomain: get(o, "EmailDomain"),
    taskDefinition: get(o, "TaskDefinition"),
    scheduleGroup: get(o, "ScheduleGroup"),
    sweepSchedule: get(o, "SweepSchedule"),
    accountSyncSchedule: get(o, "AccountSyncSchedule"),
    deadLetterQueueUrl: get(o, "DeadLetterQueueUrl"),
    secretPrefix: get(o, "SecretPrefix"),
  },
  database: dataApiDatabase({
    client: new RDSDataClient({ region: r }),
    resourceArn: get(o, "DbClusterArn"),
    secretArn: get(o, "DbSecretArn"),
    database: get(o, "DbName"),
  }),
  cognito: new CognitoIdentityProviderClient({ region: r }),
  s3: new S3Client({ region: r }),
  // CloudFront is global; its API lives in us-east-1.
  cloudFront: new CloudFrontClient({ region: "us-east-1" }),
  secrets: new SecretsManagerClient({ region: r }),
  ses: new SESv2Client({ region: r }),
  ecs: new ECSClient({ region: r }),
  scheduler: new SchedulerClient({ region: r }),
  sqs: new SQSClient({ region: r }),
});
if (result.ok) {
  console.log("ok - the Phase 0 AWS deployment checks passed");
} else {
  for (const p of result.problems) console.log(`problem - ${p}`);
  process.exitCode = 1;
}

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_ses as ses,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { COGNITO_GROUPS } from "../src/identity.ts";
import { UPLOAD_DAYS } from "../src/storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = resolve(here, "..");

/** What K Marcus gives the stand-up (from the settings file outside the repository). */
export interface MilkCrateSettings {
  /** The domain SES sends from, such as milkcrate.example. Its DNS records are added by hand. */
  emailDomain: string;
  /** The From address, on that domain. */
  emailFrom: string;
  /** The CloudFront public key, PEM. The private key goes to Secrets Manager, never here. */
  cloudFrontPublicKeyPem: string;
  /** Origins allowed to PUT parts to S3 (the desktop app's webview). Default "*". */
  uploadOrigins?: string[];
}

export interface Route {
  operationId: string;
  route: string;
  entry: string;
}

export const SECRET_PREFIX = "milk-crate/phase0/";
export const DB_NAME = "milk_crate";
export const SCHEDULE_GROUP = "milk-crate-phase0";
export const SWEEP_SCHEDULE = "mc-worker-sweep";
export const ACCOUNT_SYNC_SCHEDULE = "mc-account-sync";

/**
 * The Phase 0 AWS deployment, one stack:
 * Aurora PostgreSQL Serverless v2 with the Data API (no NAT, no bastion: everything reaches it
 * through the Data API), Cognito (pool, five groups, post-confirmation trigger), one private
 * S3 bucket, CloudFront with a key group, an HTTP API with one Lambda per operation, the
 * Fargate worker, EventBridge Scheduler (one-time runs, the hourly sweep, the account sync),
 * a dead-letter queue for failed runs, SES and IAM.
 */
export class MilkCrateStack extends Stack {
  constructor(scope: Construct, id: string, settings: MilkCrateSettings, routes: Route[], props?: StackProps) {
    super(scope, id, props);

    // Network: public subnets for the worker (it calls AWS APIs over its public IP, with no
    // inbound rule), isolated subnets for Aurora. No NAT gateway.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "database", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    // The worker reads masters from S3 through a gateway endpoint (free; no internet path).
    vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // Database: Aurora PostgreSQL 16, Serverless v2, pausing at zero capacity when idle.
    const cluster = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_9 }),
      writer: rds.ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      enableDataApi: true,
      defaultDatabaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret("mc_owner", { secretName: `${SECRET_PREFIX}database` }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dbSecret = cluster.secret!;

    // Storage: one private bucket for masters/, streams/ and art/. No versioning, so a takedown
    // really removes files. Unfinished multipart uploads are aborted after UPLOAD_DAYS.
    const bucket = new s3.Bucket(this, "Files", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: "abort-unfinished-uploads", abortIncompleteMultipartUploadAfter: Duration.days(UPLOAD_DAYS) }],
      cors: [
        {
          // Presigned part URLs are the permission; the client reads each part's ETag.
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: settings.uploadOrigins?.length ? settings.uploadOrigins : ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3600,
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Reads: CloudFront, only with signed cookies from our key group, only streams/ and art/.
    const publicKey = new cloudfront.PublicKey(this, "ReadKey", { encodedKey: settings.cloudFrontPublicKeyPem });
    const keyGroup = new cloudfront.KeyGroup(this, "ReadKeyGroup", { items: [publicKey] });
    const origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);
    const signedOnly: cloudfront.AddBehaviorOptions = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [keyGroup],
    };
    const distribution = new cloudfront.Distribution(this, "Reads", {
      comment: "Milk Crate Phase 0: streaming copies and covers, signed cookies only",
      defaultBehavior: { origin, ...signedOnly },
      additionalBehaviors: { "streams/*": { origin, ...signedOnly }, "art/*": { origin, ...signedOnly } },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    // Masters are never served, whatever a cookie says.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("masters/*")],
      }),
    );

    // Email.
    const emailIdentity = new ses.EmailIdentity(this, "Email", { identity: ses.Identity.domain(settings.emailDomain) });

    // Failed schedule runs land here with their error, kept 14 days.
    const deadLetters = new sqs.Queue(this, "FailedRuns", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Worker: Fargate, one task per job.
    const ecsCluster = new ecs.Cluster(this, "Workers", { vpc });
    const workerGroup = new ec2.SecurityGroup(this, "WorkerGroup", { vpc, allowAllOutbound: true, description: "Worker: no inbound" });
    const taskDefinition = new ecs.FargateTaskDefinition(this, "Worker", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    taskDefinition.addContainer("worker", {
      containerName: "worker",
      image: ecs.ContainerImage.fromAsset(PACKAGE_DIR, { file: "worker/Dockerfile" }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "worker",
        logGroup: new logs.LogGroup(this, "WorkerLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      }),
      environment: {
        MC_DB_CLUSTER_ARN: cluster.clusterArn,
        MC_DB_SECRET_ARN: dbSecret.secretArn,
        MC_DB_NAME: DB_NAME,
        MC_JOB_TIME_LIMIT_MINUTES: "240",
      },
      // Fargate's own limit backs up the worker's time limit.
      stopTimeout: Duration.seconds(30),
    });
    cluster.grantDataApiAccess(taskDefinition.taskRole);

    // Schedules: the group, the role one-time runs use (Data API, and the dead-letter queue).
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, "Schedules", { name: SCHEDULE_GROUP });
    const runRole = new iam.Role(this, "ScheduledRunRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "EventBridge Scheduler: run one SQL function through the Data API",
    });
    cluster.grantDataApiAccess(runRole);
    deadLetters.grantSendMessages(runRole);

    // Settings every Lambda gets. No secret values: only names and ARNs.
    const userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const g of COGNITO_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `Group-${g.name}`, {
        userPoolId: userPool.userPoolId,
        groupName: g.name,
        precedence: g.precedence,
        description: `account_type ${g.name} (db/account-claim.json)`,
      });
    }
    const appClient = userPool.addClient("DesktopApp", {
      generateSecret: false,
      // userSrp for the app. adminUserPassword needs AWS credentials (AdminInitiateAuth), so it
      // is not open to the public; the smoke test uses it to get a real token.
      authFlows: { userSrp: true, adminUserPassword: true },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    const base: Record<string, string> = {
      MC_DB_CLUSTER_ARN: cluster.clusterArn,
      MC_DB_SECRET_ARN: dbSecret.secretArn,
      MC_DB_NAME: DB_NAME,
      NODE_OPTIONS: "--enable-source-maps",
    };
    const lambdaDefaults = (id: string, entry: string, environment: Record<string, string>): nodejs.NodejsFunctionProps => ({
      entry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      projectRoot: PACKAGE_DIR,
      depsLockFilePath: join(PACKAGE_DIR, "package-lock.json"),
      // Bundle the pinned AWS SDK rather than use the runtime's, so code and tests use one version.
      bundling: { minify: true, sourceMap: true, target: "node22", format: nodejs.OutputFormat.CJS, externalModules: [] },
      logGroup: new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: { ...base, ...environment },
    });

    // Cognito's post-confirmation trigger: email into an existing api_accounts row, then groups.
    const postConfirmation = new nodejs.NodejsFunction(
      this,
      "PostConfirmation",
      { ...lambdaDefaults("PostConfirmation", join(PACKAGE_DIR, "lambda/post-confirmation.ts"), {}), timeout: Duration.seconds(10) },
    );
    cluster.grantDataApiAccess(postConfirmation);
    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmation);
    // The pool's own ARN here would make a loop (pool → trigger → pool), so any pool in this
    // account and region.
    const anyPool = Stack.of(this).formatArn({ service: "cognito-idp", resource: "userpool", resourceName: "*" });
    const groupActions = ["cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup"];
    postConfirmation.addToRolePolicy(new iam.PolicyStatement({ actions: groupActions, resources: [anyPool] }));

    // The account sync, every 15 minutes and by hand.
    const accountSync = new nodejs.NodejsFunction(this, "AccountSync", {
      ...lambdaDefaults("AccountSync", join(PACKAGE_DIR, "lambda/account-sync.ts"), { MC_COGNITO_USER_POOL_ID: userPool.userPoolId }),
      timeout: Duration.minutes(5),
    });
    cluster.grantDataApiAccess(accountSync);
    accountSync.addToRolePolicy(
      new iam.PolicyStatement({ actions: [...groupActions, "cognito-idp:ListUsers"], resources: [userPool.userPoolArn] }),
    );

    const syncRole = new iam.Role(this, "AccountSyncScheduleRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    accountSync.grantInvoke(syncRole);
    deadLetters.grantSendMessages(syncRole);
    const syncSchedule = new scheduler.CfnSchedule(this, "AccountSyncSchedule", {
      name: ACCOUNT_SYNC_SCHEDULE,
      groupName: SCHEDULE_GROUP,
      scheduleExpression: "rate(15 minutes)",
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: { arn: accountSync.functionArn, roleArn: syncRole.roleArn, input: "{}", deadLetterConfig: { arn: deadLetters.queueArn } },
    });
    syncSchedule.addResourceDependency(scheduleGroup);

    // The hourly sweep: a worker task with MC_WORKER_MODE=sweep.
    const sweepRole = new iam.Role(this, "SweepScheduleRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    sweepRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [taskDefinition.taskDefinitionArn],
        conditions: { ArnEquals: { "ecs:cluster": ecsCluster.clusterArn } },
      }),
    );
    sweepRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [taskDefinition.taskRole.roleArn, taskDefinition.obtainExecutionRole().roleArn],
      }),
    );
    deadLetters.grantSendMessages(sweepRole);
    const publicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds;
    const sweepSchedule = new scheduler.CfnSchedule(this, "SweepSchedule", {
      name: SWEEP_SCHEDULE,
      groupName: SCHEDULE_GROUP,
      scheduleExpression: "rate(1 hour)",
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: {
        arn: ecsCluster.clusterArn,
        roleArn: sweepRole.roleArn,
        deadLetterConfig: { arn: deadLetters.queueArn },
        ecsParameters: {
          taskDefinitionArn: taskDefinition.taskDefinitionArn,
          launchType: "FARGATE",
          taskCount: 1,
          networkConfiguration: {
            awsvpcConfiguration: { subnets: publicSubnets, securityGroups: [workerGroup.securityGroupId], assignPublicIp: "ENABLED" },
          },
        },
        input: JSON.stringify({ containerOverrides: [{ name: "worker", environment: [{ name: "MC_WORKER_MODE", value: "sweep" }] }] }),
      },
    });
    sweepSchedule.addResourceDependency(scheduleGroup);

    // The API: an HTTP API with one Lambda per operation (functions/routes.json; empty until
    // session G's handlers exist). Identity checks the token itself, so routes have no authorizer.
    const api = new apigw.HttpApi(this, "Api", { description: "Milk Crate Phase 0 API", createDefaultStage: true });
    const operationEnv: Record<string, string> = {
      MC_BUCKET: bucket.bucketName,
      MC_CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
      MC_CLOUDFRONT_KEY_PAIR_ID: publicKey.publicKeyId,
      MC_COGNITO_USER_POOL_ID: userPool.userPoolId,
      MC_COGNITO_CLIENT_IDS: appClient.userPoolClientId,
      MC_ECS_CLUSTER: ecsCluster.clusterName,
      MC_ECS_TASK_DEFINITION: taskDefinition.taskDefinitionArn,
      MC_ECS_CONTAINER: "worker",
      MC_ECS_SUBNETS: publicSubnets.join(","),
      MC_ECS_SECURITY_GROUPS: workerGroup.securityGroupId,
      MC_SCHEDULE_GROUP: SCHEDULE_GROUP,
      MC_SCHEDULER_ROLE_ARN: runRole.roleArn,
      MC_SCHEDULER_DLQ_ARN: deadLetters.queueArn,
      MC_SECRET_PREFIX: SECRET_PREFIX,
      MC_EMAIL_FROM: settings.emailFrom,
      MC_READ_TTL_SECONDS: "600",
    };
    const appSecrets = Stack.of(this).formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `${SECRET_PREFIX}*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    for (const r of routes) {
      const match = /^([A-Z]+) (\/v1\/[^\s]*)$/.exec(r.route);
      if (!match || !/^[A-Za-z]+$/.test(r.operationId) || !/^[A-Za-z0-9_-]+\.ts$/.test(r.entry)) {
        throw new Error(`bad route in functions/routes.json: ${JSON.stringify(r)}`);
      }
      const fn = new nodejs.NodejsFunction(this, `Op-${r.operationId}`, {
        ...lambdaDefaults(`Op-${r.operationId}`, join(PACKAGE_DIR, "functions", r.entry), operationEnv),
        // API Gateway waits at most 30 seconds.
        timeout: Duration.seconds(29),
      });
      cluster.grantDataApiAccess(fn);
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [appSecrets] }));
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "s3:PutObject", // signing part URLs and completing uploads
            "s3:GetObject",
            "s3:DeleteObject",
            "s3:AbortMultipartUpload",
            "s3:ListMultipartUploadParts",
          ],
          resources: [bucket.arnForObjects("*")],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ["s3:ListBucket", "s3:ListBucketMultipartUploads"], resources: [bucket.bucketArn] }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ecs:RunTask"],
          resources: [taskDefinition.taskDefinitionArn],
          conditions: { ArnEquals: { "ecs:cluster": ecsCluster.clusterArn } },
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [taskDefinition.taskRole.roleArn, taskDefinition.obtainExecutionRole().roleArn, runRole.roleArn],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule"],
          resources: [Stack.of(this).formatArn({ service: "scheduler", resource: "schedule", resourceName: `${SCHEDULE_GROUP}/*` })],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [Stack.of(this).formatArn({ service: "ses", resource: "identity", resourceName: settings.emailDomain })],
        }),
      );
      api.addRoutes({
        path: match[2],
        methods: [match[1] as apigw.HttpMethod],
        integration: new integrations.HttpLambdaIntegration(`Int-${r.operationId}`, fn, {
          payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0,
        }),
      });
    }

    // What the scripts and confirm read.
    const out = (name: string, value: string) => new CfnOutput(this, `Out${name}`, { key: name, value });
    out("ApiUrl", api.apiEndpoint);
    out("DbClusterArn", cluster.clusterArn);
    out("DbSecretArn", dbSecret.secretArn);
    out("DbName", DB_NAME);
    out("UserPoolId", userPool.userPoolId);
    out("AppClientId", appClient.userPoolClientId);
    out("Bucket", bucket.bucketName);
    out("DistributionId", distribution.distributionId);
    out("DistributionDomain", distribution.distributionDomainName);
    out("KeyGroupId", keyGroup.keyGroupId);
    out("KeyPairId", publicKey.publicKeyId);
    out("EmailDomain", settings.emailDomain);
    out("EmailIdentity", emailIdentity.emailIdentityName);
    out("TaskDefinition", taskDefinition.taskDefinitionArn);
    out("ScheduleGroup", SCHEDULE_GROUP);
    out("SweepSchedule", SWEEP_SCHEDULE);
    out("AccountSyncSchedule", ACCOUNT_SYNC_SCHEDULE);
    out("AccountSyncFunction", accountSync.functionName);
    out("DeadLetterQueueUrl", deadLetters.queueUrl);
    out("SecretPrefix", SECRET_PREFIX);
    // For the smoke test (scripts/smoke.sh).
    out("EcsCluster", ecsCluster.clusterName);
    out("WorkerSubnets", publicSubnets.join(","));
    out("WorkerSecurityGroup", workerGroup.securityGroupId);
    out("SchedulerRoleArn", runRole.roleArn);
    out("DeadLetterQueueArn", deadLetters.queueArn);
  }
}

/** functions/routes.json: one entry per operation, once session G's handlers exist. */
export function readRoutes(): Route[] {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, "functions/routes.json"), "utf8")) as Route[];
}

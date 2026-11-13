// Synthesizes the CDK stack offline (no AWS account; esbuild bundles the Lambdas locally) and
// checks what it would stand up.
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { MilkCrateStack, readRoutes } from "../infra/stack.ts";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const settings = {
  emailDomain: "example.invalid",
  emailFrom: "Milk Crate <noreply@example.invalid>",
  cloudFrontPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
};
const outdir = mkdtempSync(join(tmpdir(), "mc-cdk-test-"));
after(() => rmSync(outdir, { recursive: true, force: true }));
const app = new App({ outdir });
const stack = new MilkCrateStack(app, "Test", settings, readRoutes());
const template = Template.fromStack(stack);
const json = JSON.stringify(template.toJSON());

test("Aurora PostgreSQL 16, Serverless v2 down to zero, with the Data API on", () => {
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    Engine: "aurora-postgresql",
    EngineVersion: Match.stringLikeRegexp("^16\\."),
    EnableHttpEndpoint: true,
    ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2 },
    StorageEncrypted: true,
    DatabaseName: "milk_crate",
  });
});

test("Cognito: the five groups with precedence 1 to 5, and the post-confirmation trigger", () => {
  for (const [name, precedence] of [["administrator", 1], ["internal", 2], ["internal_accounting", 3], ["third_party", 4], ["artist", 5]] as const) {
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: name, Precedence: precedence });
  }
  template.resourceCountIs("AWS::Cognito::UserPoolGroup", 5);
  template.hasResourceProperties("AWS::Cognito::UserPool", { LambdaConfig: { PostConfirmation: Match.anyValue() } });
});

test("the bucket is private, unversioned, aborts unfinished uploads and exposes ETag to uploads", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Status: "Enabled" })]) },
    CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ["PUT"], ExposedHeaders: ["ETag"] })] },
  });
  assert.ok(!/"VersioningConfiguration"/.test(json));
  // CloudFront may never read masters/.
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Action: "s3:GetObject", Principal: { Service: "cloudfront.amazonaws.com" }, Resource: Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith(["/masters/*"])]) }) })]) },
  });
});

test("CloudFront serves only with signed cookies from the key group, for streams/ and art/", () => {
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      DefaultCacheBehavior: Match.objectLike({ TrustedKeyGroups: [Match.anyValue()], ViewerProtocolPolicy: "https-only" }),
      CacheBehaviors: [
        Match.objectLike({ PathPattern: "streams/*", TrustedKeyGroups: [Match.anyValue()] }),
        Match.objectLike({ PathPattern: "art/*", TrustedKeyGroups: [Match.anyValue()] }),
      ],
    },
  });
  template.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
});

test("schedules: the hourly worker sweep and the 15-minute account sync, with the dead-letter queue", () => {
  template.hasResourceProperties("AWS::Scheduler::Schedule", {
    Name: "mc-worker-sweep",
    ScheduleExpression: "rate(1 hour)",
    Target: Match.objectLike({ EcsParameters: Match.objectLike({ LaunchType: "FARGATE" }), DeadLetterConfig: Match.anyValue(), Input: Match.stringLikeRegexp("MC_WORKER_MODE") }),
  });
  template.hasResourceProperties("AWS::Scheduler::Schedule", { Name: "mc-account-sync", ScheduleExpression: "rate(15 minutes)" });
  template.hasResourceProperties("AWS::Scheduler::ScheduleGroup", { Name: "milk-crate-phase0" });
  template.hasResourceProperties("AWS::SQS::Queue", { MessageRetentionPeriod: 14 * 86400 });
});

test("Lambdas run Node 22; the worker is a Fargate task; SES has the domain", () => {
  template.allResourcesProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x" });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", { RequiresCompatibilities: ["FARGATE"], Cpu: "1024", Memory: "2048" });
  template.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "example.invalid" });
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
});

test("no secret is in the template; no NAT gateway", () => {
  assert.ok(!json.includes("PRIVATE KEY"));
  // The database password is generated by Secrets Manager at deploy time, never written here.
  assert.ok(!/"SecretString":/.test(json));
  assert.match(json, /"GenerateSecretString":/);
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
});

test("one Lambda per operation from functions/routes.json (none until session G); bad entries are refused", () => {
  assert.deepEqual(readRoutes(), []);
  assert.throws(() => new MilkCrateStack(new App({ outdir }), "Bad", settings, [{ operationId: "x", route: "GET /other", entry: "x.ts" }]), /bad route/);
  assert.throws(() => new MilkCrateStack(new App(), "Bad2", settings, [{ operationId: "x", route: "GET /v1/x", entry: "../x.ts" }]), /bad route/);
});

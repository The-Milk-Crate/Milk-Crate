// Synthesizes the CDK stack offline (no AWS account; esbuild bundles the Lambdas locally) and
// checks what it would stand up.
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { LISTENER_OPERATIONS, MilkCrateStack, PACKAGE_DIR, READ_GRANT_OPERATIONS, readRoutes } from "../infra/stack.ts";
import { operations } from "../../../core/src/handlers/index.ts";

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

test("the bucket is private, unversioned, aborts unfinished uploads after 1 day and exposes ETag to uploads", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: "Enabled" })]) },
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

test("one Lambda and one route per operation from functions/routes.json, matching session G's handlers", () => {
  const routes = readRoutes();
  assert.deepEqual(
    routes.map((r) => `${r.operationId} ${r.route}`).sort(),
    Object.values(operations).map((o) => `${o.operationId} ${o.route}`).sort(),
  );
  for (const r of routes) {
    assert.equal(r.entry, `${r.operationId}.ts`);
    // The entry serves the operation's own handler on its own route.
    const entry = readFileSync(join(PACKAGE_DIR, "functions", r.entry), "utf8");
    assert.match(entry, new RegExp(`import \\{ ${r.operationId} \\} from "\\.\\./\\.\\./\\.\\./core/src/handlers/index\\.ts";`));
    assert.ok(entry.includes(`serveOperation("${r.route}", ${r.operationId})`), r.entry);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: r.route });
  }
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 21);
  // The worker's sweep can delete a taken-down release's files, and knows the bucket.
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: ["s3:DeleteObject", "s3:AbortMultipartUpload"] })]) },
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: [Match.objectLike({ Environment: Match.arrayWith([Match.objectLike({ Name: "MC_BUCKET" })]) })],
  });
  // Processing (session H): the worker task role reads only masters/* and writes only streams/*.
  const taskRoles = Object.entries(template.findResources("AWS::IAM::Role"))
    .filter(([, r]) => JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes("ecs-tasks.amazonaws.com"))
    .map(([id]) => id)
    .filter((id) => id.startsWith("WorkerTaskRole"));
  assert.equal(taskRoles.length, 1);
  const s3Grants: string[] = [];
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    if (!JSON.stringify(policy.Properties.Roles).includes(taskRoles[0])) continue;
    for (const st of policy.Properties.PolicyDocument.Statement) {
      for (const action of [st.Action].flat()) {
        if (!String(action).startsWith("s3:")) continue;
        const resource = JSON.stringify(st.Resource);
        const where = /\/masters\/\*/.test(resource) ? "masters/*" : /\/streams\/\*/.test(resource) ? "streams/*" : /\/\*"/.test(resource) ? "*" : "bucket";
        s3Grants.push(`${action} ${where}`);
      }
    }
  }
  assert.deepEqual(s3Grants.sort(), [
    "s3:AbortMultipartUpload *",
    "s3:DeleteObject *",
    "s3:GetObject masters/*",
    "s3:ListBucket bucket",
    "s3:ListBucketMultipartUploads bucket",
    "s3:PutObject streams/*",
  ]);
  assert.throws(() => new MilkCrateStack(new App({ outdir }), "Bad", settings, [{ operationId: "x", route: "GET /other", entry: "x.ts" }]), /bad route/);
  assert.throws(() => new MilkCrateStack(new App(), "Bad2", settings, [{ operationId: "x", route: "GET /v1/x", entry: "../x.ts" }]), /bad route/);
});

test("the API's default stage is throttled: 50 requests a second, burst 100", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::Stage", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    AutoDeploy: true,
    DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
  });
});

/** Every IAM statement on the role of one operation's Lambda, as "action resource" lines. */
function operationGrants(operationId: string): { action: string; resource: string }[] {
  const fns = Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) => id.startsWith(`Op${operationId}`));
  assert.equal(fns.length, 1, operationId);
  const roleId: string = fns[0][1].Properties.Role["Fn::GetAtt"][0];
  const grants: { action: string; resource: string }[] = [];
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    if (!JSON.stringify(policy.Properties.Roles).includes(`"${roleId}"`)) continue;
    for (const st of policy.Properties.PolicyDocument.Statement) {
      assert.equal(st.Effect, "Allow");
      for (const action of [st.Action].flat()) {
        for (const resource of [st.Resource].flat()) grants.push({ action: String(action), resource: JSON.stringify(resource) });
      }
    }
  }
  // Only CDK's managed policy for logs is attached to the role itself.
  const role = template.findResources("AWS::IAM::Role")[roleId];
  assert.ok(!role.Properties.Policies, operationId);
  assert.equal(JSON.stringify(role.Properties.ManagedPolicyArns ?? []).match(/AWSLambdaBasicExecutionRole/g)?.length, 1, operationId);
  return grants;
}

test("listener operations get a narrow role: the Data API; the read grants also read streams/* and art/*, list the bucket and read the CloudFront key", () => {
  assert.deepEqual([...LISTENER_OPERATIONS].sort(), ["getCover", "getPlayback", "getPublicRelease", "recordPlays"]);
  assert.deepEqual([...READ_GRANT_OPERATIONS].sort(), ["getCover", "getPlayback"]);
  for (const op of LISTENER_OPERATIONS) {
    const readGrant = (READ_GRANT_OPERATIONS as readonly string[]).includes(op);
    const grants = operationGrants(op);
    const actions = [...new Set(grants.map((g) => g.action))].sort();
    for (const g of grants) {
      const dataApi =
        g.action.startsWith("rds-data:") ||
        // grantDataApiAccess: the Data API reads the database secret with the caller's credentials.
        ((g.action === "secretsmanager:GetSecretValue" || g.action === "secretsmanager:DescribeSecret") && /DatabaseSecret/.test(g.resource));
      const read =
        (g.action === "s3:GetObject" && /"\/(streams|art)\/\*"/.test(g.resource)) ||
        // On the bucket itself, so a missing object is a 404 (no "/" path after the bucket).
        (g.action === "s3:ListBucket" && /^\{"Fn::GetAtt":\["Files[0-9A-F]+","Arn"\]\}$/.test(g.resource)) ||
        (g.action === "secretsmanager:GetSecretValue" && g.resource.includes("milk-crate/phase0/MC_CLOUDFRONT_PRIVATE_KEY-??????"));
      assert.ok(dataApi || (readGrant && read), `${op}: ${g.action} on ${g.resource}`);
    }
    // Nothing that writes, deletes, lists uploads, runs tasks, passes roles, schedules or sends email.
    for (const a of actions) {
      assert.ok(!/^(ecs|iam|scheduler|ses|sqs|cognito-idp):/.test(a), `${op}: ${a}`);
      assert.ok(!/^s3:(Put|Delete|Abort|ListBucketMultipartUploads|ListMultipartUploadParts)/.test(a), `${op}: ${a}`);
    }
    assert.ok(!grants.some((g) => g.resource.includes("milk-crate/phase0/*")), op);
    assert.ok(actions.includes("rds-data:ExecuteStatement"), op);
    const s3 = grants.filter((g) => g.action.startsWith("s3:")).map((g) => g.action).sort();
    if (readGrant) {
      assert.deepEqual(s3, ["s3:GetObject", "s3:GetObject", "s3:ListBucket"], op);
      assert.ok(grants.some((g) => g.resource.includes("MC_CLOUDFRONT_PRIVATE_KEY")), op);
    } else {
      // getPublicRelease and recordPlays use only the database.
      assert.deepEqual(s3, [], op);
      assert.ok(!grants.some((g) => g.resource.includes("MC_CLOUDFRONT_PRIVATE_KEY")), op);
    }
  }
});

test("every other operation keeps the full role", () => {
  const listeners = new Set<string>(LISTENER_OPERATIONS);
  const others = readRoutes().map((r) => r.operationId).filter((id) => !listeners.has(id));
  assert.equal(others.length, 17);
  for (const op of others) {
    const actions = new Set(operationGrants(op).map((g) => g.action));
    for (const a of ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "ecs:RunTask", "iam:PassRole", "scheduler:CreateSchedule", "ses:SendEmail", "secretsmanager:GetSecretValue"]) {
      assert.ok(actions.has(a), `${op}: ${a}`);
    }
  }
  // A listener id missing from routes.json stops the synth.
  const routes = readRoutes().filter((r) => r.operationId !== "getCover");
  assert.throws(() => new MilkCrateStack(new App({ outdir }), "NoCover", settings, routes), /getCover is not in functions\/routes\.json/);
});

// createAwsModules's optional clients (session G3): every client and helper it makes can be
// passed in, and each one left out is the real one. The cross-cloud suite builds its AWS side
// with createAwsModules this way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { createAwsModules } from "../src/modules.ts";
import { FakeAws } from "./fake-aws.ts";

const settings: Record<string, string> = {
  AWS_REGION: "eu-west-2",
  MC_DB_CLUSTER_ARN: "arn:aws:rds:cluster",
  MC_DB_SECRET_ARN: "arn:aws:secret:db",
  MC_COGNITO_USER_POOL_ID: "eu-west-2_Test1",
  MC_COGNITO_CLIENT_IDS: "client",
  MC_BUCKET: "mc-files",
  MC_CLOUDFRONT_DOMAIN: "d1.cloudfront.net",
  MC_CLOUDFRONT_KEY_PAIR_ID: "K1",
  MC_SCHEDULE_GROUP: "milk-crate-phase0",
  MC_SCHEDULER_ROLE_ARN: "arn:aws:iam::role/scheduler",
  MC_SCHEDULER_DLQ_ARN: "arn:aws:sqs:dlq",
  MC_EMAIL_FROM: "Milk Crate <noreply@example.com>",
};
const env = (n: string) => settings[n];

test("with no clients it builds the real ones and calls nothing", () => {
  const modules = createAwsModules(env);
  for (const name of ["database", "identity", "storage", "jobs", "schedules", "secretsAndEmail"] as const) {
    assert.ok(modules[name], name);
  }
});

test("each client passed in is the one used", async () => {
  const rdsData = new FakeAws().on(ExecuteStatementCommand, () => ({ records: [[{ longValue: 1 }]], columnMetadata: [{ name: "n" }] }));
  const secrets = new FakeAws().on({ name: "GetSecretValueCommand" }, () => ({ SecretString: "secret" }));
  const ses = new FakeAws().on({ name: "SendEmailCommand" }, () => ({ MessageId: "m1" }));
  const s3 = new FakeAws().on({ name: "DeleteObjectsCommand" }, () => ({})).on({ name: "ListObjectsV2Command" }, () => ({ Contents: [] }))
    .on({ name: "ListMultipartUploadsCommand" }, () => ({ Uploads: [] }));
  const keysAsked: string[] = [];
  const modules = createAwsModules(env, {}, {
    rdsData,
    s3,
    presign: async () => "https://example.invalid/part",
    scheduler: new FakeAws(),
    secrets,
    ses,
    signCookies: () => ({}),
    identityKeys: async (header) => {
      keysAsked.push(String(header.alg));
      throw new Error("no key in this test");
    },
  });

  assert.deepEqual(await modules.database.query("select 1 as n"), [{ n: 1 }]);
  assert.deepEqual(rdsData.names(), ["ExecuteStatementCommand"]);

  assert.equal(await modules.secretsAndEmail.getSecret("X"), "secret");
  assert.equal(secrets.names().length, 1);

  await modules.storage.delete("masters/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/");
  assert.ok(s3.names().length > 0, "the S3 client passed in is used");

  const token = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`;
  assert.equal(await modules.identity.whoIs(new Request("https://x.invalid", { headers: { authorization: `Bearer ${token}` } })), null);
  assert.deepEqual(keysAsked, ["RS256"], "the key lookup passed in is used");
});

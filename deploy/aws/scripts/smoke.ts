// The smoke test behind smoke.sh: checks against the real stood-up deployment what the
// mocked tests could not (the "could not run here" list in the pull request). Every check
// prints `ok - ...` or `FAIL - ...` and the run goes on; everything it made is removed at the
// end, also when a check fails. It writes only test data under fresh random ids.
//
// Settings from smoke.sh: MC_OUTPUTS_FILE, AWS_REGION. Optional: MC_SMOKE_EMAIL_TO (an address
// SES may send to; skipped if unset), MC_SMOKE_SKIP_WORKER=1 (skips the Fargate task, which
// takes a few minutes).
import { randomBytes, randomUUID } from "node:crypto";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { DeleteScheduleCommand, GetScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import type { Database } from "../src/core.ts";
import { errorName } from "../src/aws.ts";
import { DatabaseError, dataApiDatabase } from "../src/database.ts";
import { cognitoIdentity } from "../src/identity.ts";
import { syncOneAccount } from "../src/accounts.ts";
import { s3Storage, type SignCookies } from "../src/storage.ts";
import { fargateWorker } from "../src/fargate.ts";
import { eventBridgeSchedules, scheduleName } from "../src/schedules.ts";
import { awsSecretsAndEmail } from "../src/secrets-email.ts";
import { CLOUDFRONT_KEY_SECRET, s3Client } from "../src/modules.ts";
import { crc64nvme } from "../src/crc64nvme.ts";
import { get, readOutputs, region } from "./outputs.ts";

const o = readOutputs();
const r = region();
const MIB = 1024 ** 2;
const failures: string[] = [];
const cleanups: { what: string; run: () => Promise<unknown> }[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const note = await fn();
    console.log(`ok - ${name}${note ? ` (${note})` : ""}`);
    return true;
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(`FAIL - ${name}: ${errorName(error) || "Error"}${e.code ? ` ${e.code}` : ""}: ${e.message}`);
    failures.push(name);
    return false;
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
/** Waits for `fn` to return a value, checking every `everyMs`, up to `forMs`. */
async function waitFor<T>(what: string, forMs: number, everyMs: number, fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + forMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what} after ${Math.round(forMs / 1000)} s`);
    await sleep(everyMs);
  }
}

const database: Database = dataApiDatabase({
  client: new RDSDataClient({ region: r }),
  resourceArn: get(o, "DbClusterArn"),
  secretArn: get(o, "DbSecretArn"),
  database: get(o, "DbName"),
});
const secretsAndEmail = awsSecretsAndEmail({
  secrets: new SecretsManagerClient({ region: r }),
  ses: new SESv2Client({ region: r }),
  prefix: get(o, "SecretPrefix"),
  from: process.env.MC_EMAIL_FROM ?? "",
});
const s3 = s3Client(r);
const domain = get(o, "DistributionDomain");
const storage = s3Storage({
  s3,
  presign: (command, expiresIn) => getSignedUrl(s3, command, { expiresIn }),
  bucket: get(o, "Bucket"),
  cloudFront: {
    domain,
    keyPairId: get(o, "KeyPairId"),
    privateKey: () => secretsAndEmail.getSecret(CLOUDFRONT_KEY_SECRET),
    signCookies: getSignedCookies as unknown as SignCookies,
  },
});

// Fresh ids for everything this run makes.
const artist = randomUUID();
const release = randomUUID();
const track = randomUUID();
const otherTrack = randomUUID();
const masterKey = `masters/${artist}/${release}/${track}/original`;
const streamKey = `streams/${artist}/${release}/${track}/smoke.txt`;
const otherStreamKey = `streams/${artist}/${release}/${otherTrack}/smoke.txt`;
cleanups.push({ what: "the test files", run: async () => { for (const p of ["masters", "streams"]) await storage.delete(`${p}/${artist}/${release}/`); } });

console.log(`Smoke test, run ${release.slice(0, 8)}, in ${r}`);

// 1. The Data API: casts, value shapes, errors, transactions.
await check("Data API: :p1::uuid parameters and session E's value shapes", async () => {
  const id = randomUUID();
  const [row] = await database.query<Record<string, unknown>>(
    `select $1::uuid as id, '2026-01-02 03:04:05.123456+00'::timestamptz as ts, '2026-01-02'::date as d,
            12.50::numeric as n, 5368709120::bigint as big, 7::int as small, true as b, '{"a":[1]}'::jsonb as j,
            $2::text as evil`,
    [id, "'); drop table api_jobs; --"],
  );
  const want = { id, ts: "2026-01-02 03:04:05.123456+00", d: "2026-01-02", n: "12.50", big: "5368709120", small: 7, b: true, j: { a: [1] }, evil: "'); drop table api_jobs; --" };
  expect(JSON.stringify(row) === JSON.stringify(want), `got ${JSON.stringify(row)}, want ${JSON.stringify(want)}`);
  return "timestamptz, date, numeric, bigint, jsonb as on Supabase";
});
await check("Data API: session B's error comes out as DatabaseError MC404 with its message", async () => {
  try {
    await database.query("select public.api_create_job($1::uuid, 'process_release')", [randomUUID()]);
  } catch (error) {
    expect(error instanceof DatabaseError, `not a DatabaseError: ${(error as Error).message}`);
    expect(error.code === "MC404" && error.message === "not_found: no such release", `got ${error.code} "${error.message}"`);
    return;
  }
  throw new Error("no error was raised");
});
await check("Data API: a failed transaction changes nothing", async () => {
  const id = randomUUID();
  await database
    .transaction(async (tx) => {
      await tx.query("insert into public.api_accounts (user_id, account_type) values ($1::uuid, 'third_party')", [id]);
      throw new Error("stop");
    })
    .catch(() => {});
  const rows = await database.query("select 1 from public.api_accounts where user_id = $1::uuid", [id]);
  expect(rows.length === 0, "the row was kept");
});

// 2. Uploads: presigned parts with no part checksum, resume, CRC64NVME confirm.
const size = 9 * MIB; // two parts of the 8 MiB plan
const wav = new Uint8Array(size);
wav.set(new TextEncoder().encode("RIFF"), 0);
new DataView(wav.buffer).setUint32(4, size - 8, true);
wav.set(new TextEncoder().encode("WAVEfmt "), 8);
for (let i = 44; i < size; i++) wav[i] = (i * 2654435761) >>> 24;
const crc = crc64nvme(wav);
let uploadId = "";
const etags = new Map<number, string>();
async function putPart(url: string, n: number) {
  const body = wav.subarray((n - 1) * 8 * MIB, Math.min(n * 8 * MIB, size));
  const response = await fetch(url, { method: "PUT", body });
  if (!response.ok) throw new Error(`S3 refused part ${n} (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const etag = response.headers.get("etag");
  expect(etag, `part ${n} came back without an ETag`);
  etags.set(n, etag);
}

const uploaded = await check("upload: presigned part with no part checksum, on a full-object CRC64NVME upload", async () => {
  const session = await storage.startUpload({ key: masterKey, format: "wav", sizeBytes: size });
  expect(session.method === "s3_multipart" && session.partCount === 2, "expected 2 parts");
  uploadId = session.providerUploadId;
  await putPart(session.parts[0].url, 1);
});
if (uploaded) {
  await check("upload: resume lists the stored part and signs only the missing one", async () => {
    const session = await storage.getUpload(masterKey, uploadId);
    if (session.method !== "s3_multipart") throw new Error("method");
    expect(session.completedParts.map((p) => p.partNumber).join() === "1", `completed: ${JSON.stringify(session.completedParts)}`);
    expect(session.parts.map((p) => p.partNumber).join() === "2", `signed: ${session.parts.map((p) => p.partNumber)}`);
    const [part2] = await storage.signParts(masterKey, uploadId, [2]);
    await putPart(part2.url, 2);
  });
  const parts = () => [...etags].map(([partNumber, etag]) => ({ partNumber, etag }));
  await check("confirm: a wrong CRC64NVME is checksum_mismatch and the upload stays open", async () => {
    const wrong = crc64nvme(wav.subarray(1));
    const result = await storage.confirmUpload({ key: masterKey, providerUploadId: uploadId, sha256: "0".repeat(64), crc64nvme: wrong, parts: parts() });
    expect(!result.ok && result.reason === "checksum_mismatch", `got ${JSON.stringify(result)}`);
    const session = await storage.getUpload(masterKey, uploadId);
    if (session.method !== "s3_multipart") throw new Error("method");
    expect(session.completedParts.length === 2, "the upload did not stay open with both parts");
  });
  await check("confirm: the right CRC64NVME completes, and confirming again is still ok", async () => {
    const input = { key: masterKey, providerUploadId: uploadId, sha256: "0".repeat(64), crc64nvme: crc, parts: parts() };
    const first = await storage.confirmUpload(input);
    expect(first.ok, `got ${JSON.stringify(first)}`);
    const again = await storage.confirmUpload(input);
    expect(again.ok, `second confirm got ${JSON.stringify(again)}`);
    return `CRC64NVME ${crc}`;
  });
  await check("readHead: a ranged GET of the first bytes", async () => {
    const head = await storage.readHead(masterKey, 12);
    const text = new TextDecoder().decode(head);
    expect(head.length === 12 && text.startsWith("RIFF") && text.endsWith("WAVE"), `got ${JSON.stringify(text)}`);
  });
}

// 3. Reads through CloudFront with signed cookies.
const cookieHeader = (cookies: { name: string; value: string }[]) => cookies.map((c) => `${c.name}=${c.value}`).join("; ");
await check("CloudFront: signed cookies read the track's streaming copy; nothing else", async () => {
  for (const key of [streamKey, otherStreamKey]) {
    await s3.send(new PutObjectCommand({ Bucket: get(o, "Bucket"), Key: key, Body: `smoke ${key}`, ContentType: "text/plain" }));
  }
  const grant = await storage.signRead({ key: streamKey, userId: randomUUID() });
  if (grant.method !== "cloudfront_cookies") throw new Error("method");
  const cookie = cookieHeader(grant.cookies);
  // A new distribution can take a few minutes to answer everywhere.
  const body = await waitFor("CloudFront to serve the file", 5 * 60_000, 15_000, async () => {
    const res = await fetch(grant.streamUrl, { headers: { cookie } });
    return res.ok ? res.text() : undefined;
  });
  expect(body === `smoke ${streamKey}`, `wrong body: ${body.slice(0, 80)}`);
  const noCookie = await fetch(grant.streamUrl);
  expect(noCookie.status === 403, `without cookies: ${noCookie.status}, want 403`);
  const other = await fetch(`https://${domain}/${otherStreamKey}`, { headers: { cookie } });
  expect(other.status === 403, `another track with these cookies: ${other.status}, want 403`);
  return `expires ${grant.expiresAt}`;
});
await check("CloudFront: a master is never served, even with cookies signed for it", async () => {
  // signRead refuses masters, so sign by hand with the same key to test the bucket's own rule.
  const policy = JSON.stringify({ Statement: [{ Resource: `https://${domain}/masters/${artist}/${release}/*`, Condition: { DateLessThan: { "AWS:EpochTime": Math.floor(Date.now() / 1000) + 300 } } }] });
  const cookies = getSignedCookies({ policy, keyPairId: get(o, "KeyPairId"), privateKey: await secretsAndEmail.getSecret(CLOUDFRONT_KEY_SECRET) }) as unknown as Record<string, string>;
  const res = await fetch(`https://${domain}/${masterKey}`, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
  expect(res.status === 403, `got ${res.status}, want 403`);
});

// 4. Cognito: a real token, the claim from groups, the sync and suspension.
const cognito = new CognitoIdentityProviderClient({ region: r });
const poolId = get(o, "UserPoolId");
const clientId = get(o, "AppClientId");
const identity = cognitoIdentity({ region: r, userPoolId: poolId, clientIds: [clientId] });
await check("Cognito: the token's claim follows api_accounts through the sync, and a suspended row is end_user", async () => {
  const email = `smoke-${release.slice(0, 8)}@example.invalid`;
  // Only in memory, never printed.
  const password = `${randomBytes(18).toString("base64url")}Aa1`;
  const created = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: poolId, Username: email, MessageAction: "SUPPRESS",
    UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
  }));
  const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
  expect(sub, "Cognito returned no sub");
  cleanups.push({ what: "the test user", run: () => cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: email })) });
  cleanups.push({ what: "the test account row", run: () => database.query("delete from public.api_accounts where user_id = $1::uuid", [sub]) });
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: email, Password: password, Permanent: true }));
  const claim = async () => {
    const auth = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: poolId, ClientId: clientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    const token = auth.AuthenticationResult?.AccessToken;
    expect(token, "no access token");
    const caller = await identity.whoIs(new Request("https://api.invalid/v1/x", { headers: { authorization: `Bearer ${token}` } }));
    expect(caller?.userId === sub, `Identity returned ${JSON.stringify(caller)}`);
    return caller.accountType;
  };
  const deps = { database, cognito, userPoolId: poolId, log: () => {} };
  expect((await claim()) === "end_user", "a user with no row should be end_user");
  await database.query("insert into public.api_accounts (user_id, account_type, email) values ($1::uuid, 'third_party', $2::text)", [sub, email]);
  await syncOneAccount(deps, sub);
  const asThirdParty = await claim();
  expect(asThirdParty === "third_party", `after the sync: ${asThirdParty}, want third_party`);
  await database.query("update public.api_accounts set suspended = true where user_id = $1::uuid", [sub]);
  await syncOneAccount(deps, sub);
  const asSuspended = await claim();
  expect(asSuspended === "end_user", `suspended: ${asSuspended}, want end_user`);
  return "end_user → third_party → suspended end_user, verified against the pool's JWKS";
});

// 5. Schedules: Scheduler calls the Data API; a run deletes itself; a failure lands in the DLQ.
const scheduler = new SchedulerClient({ region: r });
const sqs = new SQSClient({ region: r });
const group = get(o, "ScheduleGroup");
const schedules = eventBridgeSchedules({
  scheduler, database, group,
  roleArn: get(o, "SchedulerRoleArn"),
  deadLetterArn: get(o, "DeadLetterQueueArn"),
  resourceArn: get(o, "DbClusterArn"),
  secretArn: get(o, "DbSecretArn"),
  databaseName: get(o, "DbName"),
});
const okName = `smoke-ok-${release.slice(0, 8)}`;
const failName = `smoke-fail-${release.slice(0, 8)}`;
const failRelease = randomUUID();
for (const name of [okName, failName]) {
  cleanups.push({
    what: `schedule ${name}`,
    run: () => scheduler.send(new DeleteScheduleCommand({ Name: scheduleName(name), GroupName: group })).catch((e) => {
      if (errorName(e) !== "ResourceNotFoundException") throw e;
    }),
  });
}
const now = new Date();
const setOk = await check("Schedules: set a go-live run and a run that will fail", async () => {
  // go-live on an unknown release does nothing and raises nothing.
  await schedules.runSqlFunctionAt({ name: okName, fn: "api_release_go_live", args: { p_release_id: randomUUID() }, at: now });
  // api_create_job on an unknown release raises MC404.
  await schedules.runSqlFunctionAt({ name: failName, fn: "api_create_job", args: { p_release_id: failRelease, p_kind: "process_release" }, at: now });
});
if (setOk) {
  await check("Schedules: the run fired through the Data API and the schedule deleted itself", async () => {
    await waitFor("the schedule to run and delete itself", 5 * 60_000, 15_000, async () => {
      try {
        await scheduler.send(new GetScheduleCommand({ Name: scheduleName(okName), GroupName: group }));
        return undefined;
      } catch (e) {
        if (errorName(e) === "ResourceNotFoundException") return true;
        throw e;
      }
    });
  });
  await check("Schedules: the failed run is in the dead-letter queue with its error", async () => {
    const queueUrl = get(o, "DeadLetterQueueUrl");
    const message = await waitFor("the failed run in the dead-letter queue", 6 * 60_000, 0, async () => {
      const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 30, MessageAttributeNames: ["All"] }));
      return (out.Messages ?? []).find((m) => (m.Body ?? "").includes(failRelease));
    });
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    const attrs = Object.fromEntries(Object.entries(message.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? ""]));
    // What the open point asks: how much of the SQL error the message carries.
    console.log(`    the dead-letter message's attributes: ${JSON.stringify(attrs).slice(0, 1500)}`);
    return Object.values(attrs).some((v) => v.includes("MC404") || v.includes("not_found")) ? "it carries the SQL error" : "it does NOT carry the SQL error text; see the attributes above";
  });
}

// 6. The worker on Fargate: ECS starts one task per job id, and the image runs.
if (process.env.MC_SMOKE_SKIP_WORKER === "1") {
  console.log("skip - the Fargate worker (MC_SMOKE_SKIP_WORKER=1)");
} else {
  await check("Fargate: two starts for one job id make one task, and the worker exits cleanly", async () => {
    const ecs = new ECSClient({ region: r });
    const cluster = get(o, "EcsCluster");
    const jobId = randomUUID(); // no such job: the worker says "not queued; nothing to do" and exits
    const worker = fargateWorker({
      ecs, cluster, taskDefinition: get(o, "TaskDefinition"), container: "worker",
      subnets: get(o, "WorkerSubnets").split(","), securityGroups: [get(o, "WorkerSecurityGroup")],
    });
    await worker.startJob(jobId);
    await worker.startJob(jobId);
    const startedBy = `job-${jobId.slice(0, 30)}`;
    const arns: string[] = [];
    for (const desiredStatus of ["RUNNING", "STOPPED"] as const) {
      arns.push(...((await ecs.send(new ListTasksCommand({ cluster, startedBy, desiredStatus }))).taskArns ?? []));
    }
    const unique = [...new Set(arns)];
    expect(unique.length === 1, `${unique.length} tasks were started for one job id`);
    const task = await waitFor("the worker task to stop", 10 * 60_000, 15_000, async () => {
      const t = (await ecs.send(new DescribeTasksCommand({ cluster, tasks: unique }))).tasks?.[0];
      return t?.lastStatus === "STOPPED" ? t : undefined;
    });
    const exit = task.containers?.[0]?.exitCode;
    expect(exit === 0, `the worker exited with ${exit} (${task.stoppedReason ?? ""}); see its logs in CloudWatch`);
  });
}

// 7. Email through SES, only when an address is given.
if (process.env.MC_SMOKE_EMAIL_TO) {
  await check(`SES: send release_taken_down to ${process.env.MC_SMOKE_EMAIL_TO}`, async () => {
    expect(process.env.MC_EMAIL_FROM, "MC_EMAIL_FROM is not set");
    await secretsAndEmail.sendTemplate({ template: "release_taken_down", to: process.env.MC_SMOKE_EMAIL_TO!, data: { releaseTitle: "Smoke test", reason: "A smoke test of the Phase 0 AWS deployment. Nothing was taken down." } });
    return "check the inbox";
  });
} else {
  console.log("skip - SES (set MC_SMOKE_EMAIL_TO to an address SES may send to)");
}

// Clean up, newest first.
let left = 0;
for (const c of cleanups.reverse()) {
  try {
    await c.run();
  } catch (error) {
    console.log(`FAIL - removing ${c.what}: ${(error as Error).message}`);
    failures.push(`cleanup: ${c.what}`);
    left++;
  }
}
console.log(
  left
    ? `${left} of ${cleanups.length} test items could not be removed (run ${release.slice(0, 8)}); remove them by hand`
    : `removed what the run made (${cleanups.length} items)`,
);

if (failures.length) {
  console.log(`${failures.length} checks failed.`);
  process.exitCode = 1;
} else {
  console.log("All smoke checks passed.");
}

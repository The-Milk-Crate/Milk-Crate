// The two module sets, built from sessions E's and F's own code with only their outermost edges
// replaced, each behind its own HTTP adapter, plus what a test needs around them (accounts and
// tokens, the worker, the schedule firing, the emails sent).
//
// Supabase (session E): createSupabaseModules itself, from settings, with one fetch that
// reaches E's in-memory Supabase Storage (test/fake-storage.ts), the project's JWKS and Resend.
// The database is a local Postgres with C's Supabase stand-in and E's pg_cron stand-in, set up
// by E's own apply-sql.sh. Requests go through E's Edge Function adapter (edgeFunctions) and the
// one `api` function's router, as deployed.
//
// AWS (session F): createAwsModules itself, from settings, with each SDK client passed in as a
// fake at its `send` edge: F's Data API stand-in over a local Postgres (migrations applied F's
// way), an in-memory S3 and CloudFront (fake-s3.ts, on F's FakeAws), FakeAws for Scheduler,
// Secrets Manager and SES, a local presigner and a local JWKS. Requests go through F's Lambda adapter, one function per routes.json entry,
// behind a stand-in for API Gateway's route matching.
//
// Both use session H's processing step (worker/src/) through each worker's skeleton
// (worker/run.ts) and session G's job-result function, as each worker/main.ts does.
import { createRequire } from "node:module";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from "jose";
import type { AccountType, Database, Modules } from "../../../core/src/platform/index.ts";
import { makeApplyJobResult, operations, router } from "../../../core/src/handlers/index.ts";
import { makeProcessRelease } from "../../../worker/src/index.ts";
// Session E.
import { createSupabaseModules } from "../../../deploy/supabase/src/modules.ts";
import { edgeFunctions } from "../../../deploy/supabase/src/functions.ts";
import { runOneJob as runOnFly } from "../../../deploy/supabase/worker/run.ts";
import { coreSweep as sweepOnFly } from "../../../deploy/supabase/worker/wiring.ts";
import { BASE, PUBLISHABLE_KEY, SERVICE_KEY, fakeStorage } from "../../../deploy/supabase/test/fake-storage.ts";
import type { ClosableDatabase } from "../../../deploy/supabase/src/database.ts";
// Session F.
import type { SignCookies } from "../../../deploy/aws/src/storage.ts";
import { lambdaFunctions, type HttpApiEvent, type LambdaHandler } from "../../../deploy/aws/src/functions.ts";
import { CLOUDFRONT_KEY_SECRET, createAwsModules } from "../../../deploy/aws/src/modules.ts";
import { runOneJob as runOnFargate } from "../../../deploy/aws/worker/run.ts";
import { coreSweep as sweepOnFargate } from "../../../deploy/aws/worker/wiring.ts";
import { FakeAws } from "../../../deploy/aws/test/fake-aws.ts";
import { FakeDataApi } from "../../../deploy/aws/test/fake-data-api.ts";
import { Api } from "./client.ts";
import { fakeS3 } from "./fake-s3.ts";

// The AWS SDK packages live in deploy/aws/node_modules.
const awsRequire = createRequire(new URL("../../../deploy/aws/package.json", import.meta.url));

export type Side = "supabase" | "aws";
export const SIDES: Side[] = ["supabase", "aws"];

export interface Account {
  userId: string;
  type: AccountType;
  token: string;
  artistId?: string;
  email?: string;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface MockDeployment {
  side: Side;
  /** The deployment's API, through its own adapter. */
  api: Api;
  /** What a client's other requests reach: upload endpoints and read grants. */
  clientFetch: typeof fetch;
  /** The side's own Database module (Postgres on Supabase, the Data API on AWS). */
  db: Database;
  /** An account of this type, with its api_accounts row as the sync writes it, and a token. */
  account(type: AccountType, opts?: { suspended?: boolean; noRow?: boolean }): Promise<Account>;
  /** A token for this user saying this type (as the hook or the Cognito groups would). */
  token(userId: string, type: AccountType): Promise<string>;
  /** Runs every queued job through the worker skeleton and H's processing step. */
  runJobs(): Promise<string[]>;
  /** The core part of the worker's hourly sweep (worker/wiring.ts coreSweep), as deployed. */
  sweep(): Promise<void>;
  /** Moves the clock to the schedule's time and fires it as pg_cron or Scheduler would. */
  fireSchedule(name: string): Promise<void>;
  /** When the schedule of this name is set to run (UTC, ISO), or null. */
  scheduledAt(name: string): Promise<string | null>;
  emails: Email[];
  /** Keys stored under a prefix (masters/, streams/ or art/...). */
  keys(prefix: string): string[];
  /** Stores an object straight in (test seeding only). */
  putObject(key: string, bytes: Uint8Array, contentType: string): void;
  logs: string[];
  close(): Promise<void>;
}

const MIB = 1024 * 1024;
/** The free Supabase project's file size limit (settled: MC_FILE_SIZE_LIMIT=50MiB). */
export const FILE_SIZE_LIMIT = "50MiB";

// ---------- Supabase (session E) ----------

export async function supabaseDeployment(dbUrl: string): Promise<MockDeployment> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const emails: Email[] = [];

  // The buckets as E's 0002_buckets.sql made them in this database.
  const admin = createSupabaseModules((n) => ({ SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_DB_URL: dbUrl })[n], { poolSize: 1 });
  const buckets = await admin.database.query<{ id: string; max: string | null; mimes: string[] | null }>(
    "select id, file_size_limit::text as max, allowed_mime_types as mimes from storage.buckets where id like 'mc-%'",
  );
  await admin.database.close();
  const storage = fakeStorage(Object.fromEntries(buckets.map((b) => [b.id, { max: b.max === null ? null : Number(b.max), mimes: b.mimes }])));

  // The project's signing key: the JWKS E's identity module fetches.
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "sb-test", alg: "ES256", use: "sig" };

  const serverFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (req.url === `${BASE}/auth/v1/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url.origin === BASE && url.pathname.startsWith("/storage/v1/")) return storage.fetch(req);
    if (url.origin === "https://api.resend.com" && url.pathname === "/emails") {
      if (req.headers.get("authorization") !== "Bearer re_test_only") return new Response("no key", { status: 401 });
      const m = (await req.json()) as { to: string[]; subject: string; text: string };
      emails.push({ to: m.to[0], subject: m.subject, text: m.text });
      return Response.json({ id: randomUUID() });
    }
    return new Response(`no route for ${req.method} ${req.url}`, { status: 501 });
  }) as typeof fetch;

  // The Edge Function's settings (scripts/secrets.env.example). No FLY_API_TOKEN: jobs wait in
  // the table, and runJobs() plays the worker.
  const settings: Record<string, string> = {
    SUPABASE_URL: BASE,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SUPABASE_DB_URL: dbUrl,
    MC_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    MC_FILE_SIZE_LIMIT: FILE_SIZE_LIMIT,
    MC_EMAIL_FROM: "Milk Crate <noreply@example.com>",
    RESEND_API_KEY: "re_test_only",
  };
  let database!: ClosableDatabase;
  const modules = createSupabaseModules((n) => settings[n], {
    fetch: serverFetch,
    poolSize: 4,
    applyJobResult: (jobId, result) => makeApplyJobResult({ database })(jobId, result),
  });
  database = modules.database;

  // The one `api` Edge Function: serveOperation("*", router), with Deno.serve replaced.
  let serve: ((r: Request) => Response | Promise<Response>) | undefined;
  edgeFunctions({ serve: (h) => { serve = h; }, log }).handle("*", router, modules as Modules);
  await new Promise((r) => setTimeout(r, 0));
  const apiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => serve!(new Request(input, init))) as typeof fetch;

  // A client reaches TUS and signed reads. E's fake signs reads but does not serve them; this
  // serves a signed link's object, as Storage does for a valid token.
  const clientFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(decodeURIComponent(url.pathname));
    if (req.method === "GET" && m) {
      if (!/^read\d+\.\d+$/.test(url.searchParams.get("token") ?? "")) return new Response("bad token", { status: 400 });
      const o = storage.objects.get(`${m[1]}/${m[2]}`);
      if (!o) return new Response(JSON.stringify({ message: "Object not found" }), { status: 400 });
      return new Response(o.bytes.slice() as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": o.contentType } });
    }
    return storage.fetch(req);
  }) as typeof fetch;

  const token = (userId: string, type: AccountType) =>
    new SignJWT({ role: "authenticated", account_type: type, is_anonymous: false })
      .setProtectedHeader({ alg: "ES256", kid: "sb-test" })
      .setSubject(userId)
      .setIssuer(`${BASE}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  const bucketOf = (key: string) => ({ masters: "mc-masters", streams: "mc-streams", art: "mc-art" })[key.split("/")[0]]!;

  return {
    side: "supabase",
    api: new Api(`${BASE}/functions/v1/api`, apiFetch),
    clientFetch,
    db: database,
    account: (type, opts) => newAccount(database, type, opts, token),
    token,
    async runJobs() {
      const jobs = modules.jobs;
      const deps = { database, jobs, process: makeProcessRelease({ database, storage: modules.storage, log }), log };
      const ran: string[] = [];
      for (let id = await runOnFly(deps); id; id = await runOnFly(deps)) ran.push(id);
      return ran;
    },
    sweep: () => sweepOnFly({ database, jobs: modules.jobs, storage: modules.storage }, log),
    async fireSchedule(name) {
      // The release date arrives: the run is due, and pg_cron runs its job's command.
      await database.query("update public.api_schedules set run_at = now() where name = $1::text", [name]);
      const [job] = await database.query<{ command: string }>("select command from cron.job where jobname = $1::text", [`mc_schedule:${name}`]);
      if (!job) throw new Error(`no pg_cron job for ${name}`);
      const [fired] = await database.query<{ api_schedule_fire: string }>(job.command);
      if (fired.api_schedule_fire !== "ran") throw new Error(`the run ${name} did not run: ${fired.api_schedule_fire}`);
    },
    async scheduledAt(name) {
      const [row] = await database.query<{ at: string }>(
        `select to_char(run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at from public.api_schedules where name = $1::text`,
        [name],
      );
      return row?.at ?? null;
    },
    emails,
    keys: (prefix) =>
      [...storage.objects.keys()].filter((k) => k.startsWith(`${bucketOf(prefix)}/${prefix}`)).map((k) => k.slice(k.indexOf("/") + 1)).sort(),
    putObject(key, bytes, contentType) {
      storage.objects.set(`${bucketOf(key)}/${key}`, { bytes, modified: Date.now(), contentType });
    },
    logs,
    close: () => database.close(),
  };
}

// ---------- AWS (session F) ----------

const REGION = "eu-west-2";
const POOL = "eu-west-2_CrossCloud1";
const CLIENT_ID = "cross-cloud-client";
const BUCKET = "mc-files";
const CLOUDFRONT = "d111crosscloud.cloudfront.net";
const KEY_PAIR_ID = "K2CROSSCLOUD";

export async function awsDeployment(dbUrl: string): Promise<MockDeployment> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const emails: Email[] = [];

  const cloudFrontKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = cloudFrontKeys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const s3 = fakeS3({
    bucket: BUCKET,
    region: REGION,
    cloudFrontDomain: CLOUDFRONT,
    cloudFrontPublicKeyPem: cloudFrontKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyPairId: KEY_PAIR_ID,
  });

  const dataApi = new FakeDataApi(dbUrl);

  const secrets = new FakeAws().on({ name: "GetSecretValueCommand" }, (input) => {
    if (input.SecretId === `milk-crate/phase0/${CLOUDFRONT_KEY_SECRET}`) return { SecretString: pem };
    const e = new Error("not found");
    e.name = "ResourceNotFoundException";
    throw e;
  });
  const ses = new FakeAws().on({ name: "SendEmailCommand" }, (input) => {
    emails.push({
      to: input.Destination.ToAddresses[0],
      subject: input.Content.Simple.Subject.Data,
      text: input.Content.Simple.Body.Text.Data,
    });
    return { MessageId: randomUUID() };
  });
  const scheduler = new FakeAws()
    .on({ name: "UpdateScheduleCommand" }, (input) => {
      if (!schedules.has(input.Name)) {
        const e = new Error("not found");
        e.name = "ResourceNotFoundException";
        throw e;
      }
      schedules.set(input.Name, input);
      return {};
    })
    .on({ name: "CreateScheduleCommand" }, (input) => {
      schedules.set(input.Name, input);
      return {};
    });
  const schedules = new Map<string, any>();

  // Presigning is local (no network) with made-up credentials, as in F's storage tests.
  const { S3Client } = awsRequire("@aws-sdk/client-s3");
  const { getSignedUrl } = awsRequire("@aws-sdk/s3-request-presigner");
  const { getSignedCookies } = awsRequire("@aws-sdk/cloudfront-signer");
  const presigner = new S3Client({
    region: REGION,
    credentials: { accessKeyId: "AKIDCROSSCLOUD", secretAccessKey: "made-up-for-tests" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "cognito-test", alg: "RS256", use: "sig" };

  // createAwsModules itself, with the stack's settings (infra/stack.ts) and the clients faked.
  const settings: Record<string, string> = {
    AWS_REGION: REGION,
    MC_DB_CLUSTER_ARN: "arn:aws:rds:cluster",
    MC_DB_SECRET_ARN: "arn:aws:secret:db",
    MC_DB_NAME: "milk_crate",
    MC_COGNITO_USER_POOL_ID: POOL,
    MC_COGNITO_CLIENT_IDS: CLIENT_ID,
    MC_BUCKET: BUCKET,
    MC_CLOUDFRONT_DOMAIN: CLOUDFRONT,
    MC_CLOUDFRONT_KEY_PAIR_ID: KEY_PAIR_ID,
    MC_READ_TTL_SECONDS: "600",
    MC_SCHEDULE_GROUP: "milk-crate-phase0",
    MC_SCHEDULER_ROLE_ARN: "arn:aws:iam::role/scheduler",
    MC_SCHEDULER_DLQ_ARN: "arn:aws:sqs:dlq",
    MC_EMAIL_FROM: "Milk Crate <noreply@example.com>",
  };
  let database!: Database;
  const modules = createAwsModules(
    (n) => settings[n],
    // As worker/main.ts does it: G's job-result function on the same database.
    { applyJobResult: (jobId, result) => makeApplyJobResult({ database })(jobId, result) },
    {
      rdsData: dataApi,
      s3: s3.s3,
      presign: (command, expiresIn) => getSignedUrl(presigner, command, { expiresIn }),
      scheduler,
      secrets,
      ses,
      signCookies: getSignedCookies as SignCookies,
      identityKeys: createLocalJWKSet({ keys: [jwk] }),
    },
  );
  database = modules.database;

  // One Lambda per routes.json entry, each serving its operation's shared handler, as
  // functions/<op>.ts does; API Gateway picks the route.
  const routes = JSON.parse(readFileSync(new URL("../../../deploy/aws/functions/routes.json", import.meta.url), "utf8")) as {
    operationId: keyof typeof operations;
    route: string;
  }[];
  const lambdas = routes.map(({ operationId, route }) => {
    const fns = lambdaFunctions({ log });
    fns.handle(route, operations[operationId].handler, modules);
    const [method, path] = route.split(" ");
    const pattern = new RegExp(`^${path.replace(/\{[A-Za-z]+\}/g, "[^/]+")}$`);
    return { method, pattern, handler: fns.lambdaHandler as LambdaHandler };
  });
  const apiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const lambda = lambdas.find((l) => l.method === req.method && l.pattern.test(url.pathname));
    // API Gateway's own answer when no route matches.
    if (!lambda) return Response.json({ message: "Not Found" }, { status: 404 });
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { if (k !== "cookie") headers[k] = v; });
    const text = req.body ? await req.text() : undefined;
    const event: HttpApiEvent = {
      version: "2.0",
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers,
      cookies: req.headers.get("cookie")?.split(/;\s*/),
      body: text,
      isBase64Encoded: false,
      requestContext: { domainName: url.host, requestId: randomUUID(), http: { method: req.method } },
    };
    const out = await lambda.handler(event);
    const h = new Headers(out.headers);
    for (const c of out.cookies ?? []) h.append("set-cookie", c);
    const body = out.isBase64Encoded ? Buffer.from(out.body, "base64") : out.body;
    return new Response(out.statusCode === 204 ? null : body, { status: out.statusCode, headers: h });
  }) as typeof fetch;

  const token = (userId: string, type: AccountType) =>
    new SignJWT({ token_use: "access", client_id: CLIENT_ID, ...(type === "end_user" ? {} : { "cognito:groups": [type] }) })
      .setProtectedHeader({ alg: "RS256", kid: "cognito-test" })
      .setSubject(userId)
      .setIssuer(`https://cognito-idp.${REGION}.amazonaws.com/${POOL}`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  const { ExecuteStatementCommand } = awsRequire("@aws-sdk/client-rds-data");

  return {
    side: "aws",
    api: new Api("https://api.example.invalid", apiFetch),
    clientFetch: s3.clientFetch,
    db: database,
    account: (type, opts) => newAccount(database, type, opts, token),
    token,
    async runJobs() {
      const deps = { database, jobs: modules.jobs, process: makeProcessRelease({ database, storage: modules.storage, log }), log };
      const ran: string[] = [];
      for (let id = await runOnFargate(deps); id; id = await runOnFargate(deps)) ran.push(id);
      return ran;
    },
    sweep: () => sweepOnFargate({ database, jobs: modules.jobs, storage: modules.storage }, log),
    async fireSchedule(name) {
      const { scheduleName } = await import("../../../deploy/aws/src/schedules.ts");
      const schedule = schedules.get(scheduleName(name));
      if (!schedule) throw new Error(`no schedule for ${name}`);
      // Scheduler calls the Data API with the target's Input (PascalCase fields), then deletes
      // the schedule (ActionAfterCompletion: DELETE).
      const input = JSON.parse(schedule.Target.Input);
      const lower = (k: string) => k[0].toLowerCase() + k.slice(1);
      const parameters = input.Parameters.map((p: { Name: string; Value: Record<string, unknown> }) => ({
        name: p.Name,
        value: Object.fromEntries(Object.entries(p.Value).map(([k, v]) => [lower(k), v])),
      }));
      await dataApi.send(
        new ExecuteStatementCommand({ resourceArn: input.ResourceArn, secretArn: input.SecretArn, database: input.Database, sql: input.Sql, parameters }),
      );
      if (schedule.ActionAfterCompletion === "DELETE") schedules.delete(scheduleName(name));
    },
    async scheduledAt(name) {
      const { scheduleName } = await import("../../../deploy/aws/src/schedules.ts");
      const s = schedules.get(scheduleName(name));
      const m = s ? /^at\((.+)\)$/.exec(s.ScheduleExpression) : null;
      return m ? `${m[1]}Z` : null;
    },
    emails,
    keys: (prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    putObject(key, bytes, contentType) {
      s3.objects.set(key, { bytes, modified: Math.floor(Date.now() / 1000) * 1000, contentType });
    },
    logs,
    close: () => dataApi.close(),
  };
}

/** The api_accounts row the account sync would write (session C on Supabase, F's sync on AWS). */
async function newAccount(
  db: Database,
  type: AccountType,
  opts: { suspended?: boolean; noRow?: boolean } = {},
  token: (userId: string, type: AccountType) => Promise<string>,
): Promise<Account> {
  const userId = randomUUID();
  const email = `${type.replace(/_/g, "-")}-${userId.slice(0, 8)}@example.com`;
  const tokenType: AccountType = opts.suspended ? "end_user" : type;
  if (type === "end_user" || opts.noRow) return { userId, type, token: await token(userId, tokenType), email };
  const artistId = type === "artist" ? randomUUID() : null;
  await db.query(
    `insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name, suspended)
     values ($1::uuid, $2::text, $3::text, $4::uuid, $5::text, $6::boolean)`,
    [userId, type, email, artistId, type === "artist" ? "Cross Cloud Artist" : null, opts.suspended ?? false],
  );
  return { userId, type, token: await token(userId, tokenType), email, ...(artistId ? { artistId } : {}) };
}

export async function makeDeployment(side: Side): Promise<MockDeployment> {
  const url = side === "supabase" ? process.env.MC_XC_SUPABASE_DB_URL : process.env.MC_XC_AWS_DB_URL;
  if (!url) throw new Error("MC_XC_SUPABASE_DB_URL and MC_XC_AWS_DB_URL are not set: run bash tests/cross-cloud/run.sh");
  return side === "supabase" ? supabaseDeployment(url) : awsDeployment(url);
}

export { MIB };

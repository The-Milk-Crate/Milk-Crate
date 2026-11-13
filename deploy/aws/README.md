# AWS deployment (Phase 0, session F)

The platform interfaces in `core/src/platform/` on AWS (Cognito, Aurora PostgreSQL through the
RDS Data API, S3, CloudFront, API Gateway and Lambda on Node 22, a worker on Fargate,
EventBridge Scheduler, SES, Secrets Manager), the CDK definition, and the scripts that stand it
up. The shared handlers are session G's; nothing here is a handler. Where the interfaces leave
room, this does what session E did on Supabase (`deploy/supabase/README.md`).

## Run the tests

```bash
bash deploy/aws/test/run.sh
```

Needs Node 22.18 or newer (it runs the TypeScript as is) and PostgreSQL 16 server binaries (set
`PG_BIN` to pick them). It installs the packages if needed (`npm ci`), type-checks, starts a
throwaway cluster like `db/test/run.sh`, applies `db/migrations/` twice the way the stand-up
does (split into single statements, each file in one Data API transaction) and twice whole with
`psql`, checks both give the same schema, runs every test, then removes the cluster. No keys, no
AWS account, no Docker, no network beyond the package install.

Every AWS service is mocked at its SDK edge (`send(command)`, `test/fake-aws.ts`). The Data API
has no emulator, so `test/fake-data-api.ts` answers its calls from the local Postgres, the way
the Data API documents them; the tests then run session B's real functions through it. The CDK
stack is synthesized offline (esbuild bundles the Lambdas locally).

`npm run test:unit` runs only the tests that need no database.

## Layout

| Path | What |
|---|---|
| `src/identity.ts` | `Identity`: the Cognito access token, checked against the pool's JWKS; `account_type` from `cognito:groups`. |
| `src/accounts.ts`, `lambda/` | The account source: the post-confirmation trigger and the group sync. |
| `src/storage.ts` | `ObjectStorage`: `s3_multipart` uploads, CRC64NVME confirm, CloudFront cookies, ranged `readHead`, delete by prefix. |
| `src/jobs.ts`, `src/fargate.ts`, `worker/` | `Jobs`: rows in `api_jobs`, a Fargate task per job, the worker skeleton and the hourly sweep. |
| `src/schedules.ts` | `Schedules` on EventBridge Scheduler, calling the Data API. |
| `src/functions.ts`, `src/lambda.ts` | `ServerFunctions`: the Lambda adapter (API Gateway HTTP API, payload 2.0) and the entry point helper. |
| `src/secrets-email.ts`, `src/email-templates.ts` | `SecretsAndEmail`: Secrets Manager; SES with session E's templates. |
| `src/database.ts`, `src/sql.ts` | `Database` over the RDS Data API; the SQL lexer (parameters and the migration splitter). |
| `src/migrations.ts` | Applies `db/migrations/` through the Data API. |
| `src/infrastructure.ts`, `scripts/` | `Infrastructure`: stand up, confirm, tear down. |
| `src/modules.ts` | Builds all the modules from the environment. |
| `infra/` | The CDK app and stack. |
| `functions/` | One Lambda entry point per operation (none yet: they wait on session G). |

## How each part works

**Database (RDS Data API).** `$1`, `$2` become `:p1`, `:p2` (a lexer skips strings, quoted names,
comments and `$$` bodies) and travel as typed Data API parameters; values never go into the SQL
text. Dates go as ISO text, lists and objects as JSON text (cast them in the SQL, as `db/README.md`
asks). A transaction is a Data API transaction id carried on each statement; statements in one
transaction run one at a time, and a failure rolls it back. Results read as on session E:
`numeric`, `bigint`, `date` and `timestamptz` as text (a `timestamptz` keeps its microseconds and
gets its `+00` back, so a list cursor round-trips), `json` and `jsonb` parsed. A Postgres error
(`...; SQLState: MC409`) becomes `DatabaseError` with `code` and the message as Postgres raised
it. Limits: a result over 1 MB becomes `DatabaseError` `54000` and a call past 45 seconds `57014`,
in plain words; while Aurora wakes from a pause the call is retried for up to about 45 seconds.
**Not the same as E:** the Data API sends a `bigint` as a JSON number, so a value above 2^53 loses
digits. B's bigints stay far below it; cast to `::text` where an exact large one matters.

**Migrations.** The stand-up applies `db/migrations/` (never `db/supabase/`) through the Data API,
each file whole in one transaction, split into statements by the tested splitter. The splitter
was chosen over `psql` because Aurora sits in isolated subnets with no public address: `psql`
would need a bastion, a public endpoint or a port forward, while the Data API needs only IAM. The
test applies every file both ways and compares the schemas.

**Identity.** Cognito access tokens only (`token_use: access`, the app client in `client_id`),
RS256, checked against `https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`.
The account type is the claim group with the lowest precedence number (`db/account-claim.json`);
no group is `end_user`; other group names are ignored. Null for no token or a bad one.

**Account source.** `api_accounts` is the one source. The post-confirmation trigger writes the
user's email into their row where one exists (never inserts) and syncs their group; it never
throws, since a throw would stop the sign-up. The sync puts each user in the group their row
names and removes every other group; a suspended row or no row means no group. It also copies
each user's verified Cognito email into their existing row (never a new one), because users
made with `admin-create-user` never fire the trigger. It runs every 15 minutes and by hand
(`scripts/sync-accounts.sh`). Staff endpoints check the row too (session
G), so a removed role stops at once; the group follows within 15 minutes, and the claim at the
next token refresh (tokens last an hour).

**Uploads (`s3_multipart`).** One private bucket; keys are `masters/...`, `streams/...`, `art/...`.
`startUpload` opens a multipart upload with `ChecksumAlgorithm: CRC64NVME` and
`ChecksumType: FULL_OBJECT` (that is the checksum setting: S3 sets it per upload, not per
bucket), plans 8 MiB parts (larger only to stay within 10,000; 5 GiB is 640 parts) and signs the
first 50. Part URLs last an hour and carry no checksum. `getUpload` lists the stored parts, so an
interrupted upload re-sends only the rest; `signParts` signs more. A lifecycle rule aborts an
unfinished upload after 7 days (the session's `expiresAt`). `providerUploadId` is the S3 upload id
with the start time and size in its fragment, as on E.
**Confirm** checks every part is there (else `incomplete`), the client's ETags and the total size
(else `checksum_mismatch`), then completes with the client's CRC64NVME; S3 refuses a wrong one and
the upload stays open (`checksum_mismatch`). It then checks the stored object's size and CRC64NVME.
A second confirm after a lost answer checks the stored object. The SHA-256 is not checked here:
an S3 multipart SHA-256 is a checksum of the parts. The worker checks it (session H).

**Reads (`cloudfront_cookies`).** CloudFront serves the bucket only with signed cookies from the
stack's key group, only for `streams/*` and `art/*`; a bucket policy denies CloudFront `masters/*`
whatever a cookie says. `signRead` refuses anything but a streaming copy or the cover key, checks
the object exists (404 otherwise), and makes fresh cookies for 600 seconds scoped to the track's
`streams/{artist}/{release}/{track}/` folder (or the release's `art/.../cover/` folder), plus the
object's address. Like E's links they are not bound to the listener (settled).

**`readHead`.** A ranged GET, at most 1 MiB. **Delete.** Release folders only (as on E): aborts
unfinished uploads under the prefix, deletes in batches of 1,000, lists again to check. The bucket
is unversioned, so a takedown really removes files. Errors are `StorageError` with `status`, as
on E (400 for a confirm without CRC64NVME or parts, 404 for no object).

**Jobs.** The queue is B's `api_jobs` table, as on E (no SQS queue: the sweep is the retry).
`enqueue` calls `api_create_job`, then `ecs:RunTask` with `clientToken` set to the job id. If the
task cannot start the row stays `queued`, enqueue still answers, and the hourly sweep (an
EventBridge schedule that starts the worker with `MC_WORKER_MODE=sweep`) runs it. The worker
skeleton is session E's, with the same rules and words (a test checks): claim with
`api_job_started`, 4-hour limit, plain-words failures, and "Processing is not set up yet ..."
until session H. `reportResult` waits on session G (`worker/wiring.ts`).

**Schedules.** One-time EventBridge schedules (`at(...)`, UTC, rounded up to the minute) whose
target is the Data API's `ExecuteStatement`: `select public.<fn>(<arg> => :<arg>::<type>)` with
each type read from the catalog and the values as parameters. `ActionAfterCompletion: DELETE`
removes the schedule after it runs; the same name replaces it. A failed run is not retried
(`MaximumRetryAttempts: 0`) and goes to the dead-letter queue with its error, kept 14 days;
`confirm` reports how many are waiting and `scripts/failed-runs.sh` shows them. Scheduler has no
missed-minute gap, so there is no daily sweep as on E.

**Server functions.** `serveOperation(route, handler)` builds the modules once per instance and
returns the Lambda handler. The event becomes a `Request` (path cut to `/v1/...`, query,
cookies, base64 bodies); the `Response` goes back with `Set-Cookie` in `cookies` and binary
bodies as base64. No match is the contract's 404; a throw is a 500 with no details, logged with
the request id. Lambdas time out at 29 seconds, inside API Gateway's 30.

**Secrets and email.** Secrets Manager, by name (`milk-crate/phase0/<NAME>`), kept 5 minutes in
memory. Chosen over Parameter Store because the Data API needs the database login in Secrets
Manager anyway: one service, one IAM rule. Email through SES v2 with session E's templates (a
copy; a test checks they render the same) and the same `data` fields.

## Stand up, confirm, tear down

K Marcus runs these; they hold no secrets. Settings come from one file kept outside the
repository (`scripts/settings.env.example`), AWS credentials from the AWS CLI profile.

```bash
MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/stand-up.sh
```

```bash
MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/confirm.sh
```

```bash
MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/tear-down.sh
```

```bash
MC_SETTINGS_FILE=/path/outside/the/repo/aws.settings.env bash deploy/aws/scripts/smoke.sh
```

The smoke test (about 10 minutes) checks against the real services what the mocked tests
could not: the Data API's parameters, value shapes and error text; presigned parts on a
CRC64NVME upload, resume and confirm; CloudFront cookies (one track only, never a master); a
real Cognito token and the claim through the sync and suspension; a schedule running through
the Data API and a failed one in the dead-letter queue; one Fargate task per job id; and, with
`MC_SMOKE_EMAIL_TO`, one SES email. It writes only test data under fresh random ids and removes
it at the end. The top of `scripts/smoke.sh` lists each check.

The stand-up, tear-down and smoke test check the credentials are for `MC_AWS_ACCOUNT` and ask you to type the
account id and the region again before changing anything. The top of each script lists what it
needs and does. The settings file is read as plain `NAME=value` lines, never run.

What you do by hand once: make the CloudFront key pair (`openssl`, see the settings example),
add SES's DKIM records to your domain's DNS (the stand-up prints them), and ask AWS to move SES
out of its sandbox (until then it sends only to verified addresses). Rows in `api_accounts` are
written by you (`user_id` is the Cognito `sub`); run `scripts/sync-accounts.sh` after.

The stack: a VPC with no NAT gateway (the worker uses a public IP with no inbound rule, and an S3
gateway endpoint), Aurora PostgreSQL 16 Serverless v2 (0 to 2 ACUs, pausing when idle) with the
Data API on, in isolated subnets.

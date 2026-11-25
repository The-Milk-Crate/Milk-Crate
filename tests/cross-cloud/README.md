# tests/cross-cloud: the cross-cloud check (session G, stage 2)

One scenario, run on the Supabase module set (session E) and on the AWS module set (session F),
through the shared router and handlers (session G) and each deployment's own HTTP adapter, then
compared step by step. Plus session C's read-access fixture on both, a table-driven coverage check
from the contract, and `run-live.ts`, the same scenario for real deployments.

## Run it

```bash
bash tests/cross-cloud/run.sh
```

From a clean checkout. It installs the packages of `tests/cross-cloud/`, `deploy/supabase/` and
`deploy/aws/` (`npm ci`) if needed, makes each deployment's `_core/` copy (`scripts/copy-core.sh`),
type-checks, starts a throwaway PostgreSQL 16 cluster in a
temp directory, runs every test, then stops the cluster and removes the directory, also when a
test fails. No keys, no Docker, no network beyond the package installs. Needs Node 22.18 or newer,
ffmpeg and ffprobe, and PostgreSQL 16 server binaries (set `PG_BIN` to pick them). About a minute.
CI job: `cross-cloud` in `.github/workflows/phase0-checks.yml`.

## What each side is made of

| | Supabase (session E) | AWS (session F) |
|---|---|---|
| Modules | `createSupabaseModules` itself, from settings, with `MC_FILE_SIZE_LIMIT=50MiB` as on the free project | `createAwsModules` itself, from settings, with each SDK client, the presigner, the cookie signer and the key lookup passed in as fakes |
| HTTP | the one `api` Edge Function: `edgeFunctions(...).handle("*", router, ...)` | one Lambda per `functions/routes.json` entry (`lambdaFunctions`), behind API Gateway's route match |
| Database | local Postgres with C's Supabase stand-in and E's pg_cron stand-in, set up by E's `scripts/apply-sql.sh` | F's Data API stand-in (`test/fake-data-api.ts`) over local Postgres, migrations applied F's way (`test/apply-split.ts`) |
| Identity | ES256 tokens checked against the project's JWKS (served to E's module), `account_type` claim | RS256 Cognito access tokens with `cognito:groups` (`cognitoIdentity`) |
| Storage | E's in-memory Supabase Storage (`test/fake-storage.ts`), TUS with `tusSend` | an in-memory S3 at the SDK edge on F's `FakeAws` (`lib/fake-s3.ts`): presigned part PUTs, CRC64NVME on complete, CloudFront that checks the signed cookies |
| Schedules | pg_cron stand-in: the run is made due, then its `cron.job` command runs | the Scheduler target's `Input` sent to the Data API, as Scheduler does |
| Email | Resend's HTTP API, faked | SES `SendEmail`, faked |
| Worker | `deploy/supabase/worker/run.ts` with session H's step (`worker/src/`) and ffmpeg | `deploy/aws/worker/run.ts` with the same step |

Both use session G's `makeApplyJobResult` for job results, as each `worker/main.ts` does, and each
worker's `coreSweep` (`worker/wiring.ts`) for the hourly sweep's late pass after a takedown.

## What "behave the same" means here

For every step: the HTTP status, the error `code`, the release `state` after the step, and the
response's field names and types (values are ignored). The tagged unions may differ:
`UploadSession` (`tus` / `s3_multipart`), `PlaybackGrant` and `CoverGrant` (`signed_url` /
`cloudfront_cookies`). For those each side must answer its own branch, valid against the
contract, and the fields both branches share must match. `signUploadParts` is for `s3_multipart`
only, so its answer is checked against each side's branch, not across sides. Facts (extra checks
such as "the upload resumes from where it stopped" or "a 30-second play qualifies") must match too.
Every answer is also checked against the contract's response schema.

## The tests

- `test/scenario.test.ts`: the scenario (steps 1 to 9 of the brief, and the refused cases) on
  both sides; each side meets the scenario's expectations and the contract; the two compare the
  same; and the coverage check: every operation's `x-account-types` (each allowed type gets a 2xx,
  each other type a 403, no token a 401), its `x-state-moves`, and every row of the contract's
  state table. A new operation or move with no step fails here. Self-tests show the comparison and
  the coverage check do catch a change.
- `test/access.test.ts`: every cell of `db/test/access-expected.json` on both sides, the
  invitation cases and callers, and the staff row check (settled with session C).
- `test/live.test.ts`: `run-live.ts` against the mocks only.
- `lib/findings.ts`: what the check found and does not fix (listed in the pull request). Empty since
  session G3 fixed G2's three findings; a test checks it stays empty until a new one is listed.

## run-live.ts: real deployments

The same scenario against one deployment, with settings only from the environment. It is
written and tested against the mocks; it has not been run against anything real.

```bash
node tests/cross-cloud/run-live.ts --help
```

Required (one base address and one token per account type):

| Variable | What |
|---|---|
| `MC_LIVE_BASE_URL` | The API's base address, before `/v1/...`. Supabase: `https://<ref>.supabase.co/functions/v1/api`. AWS: the API Gateway address. |
| `MC_LIVE_TOKEN_ARTIST` | A bearer token for an artist account. |
| `MC_LIVE_TOKEN_END_USER` | A listener. |
| `MC_LIVE_TOKEN_THIRD_PARTY` | A third party. |
| `MC_LIVE_TOKEN_ADMINISTRATOR` | An administrator (with its `api_accounts` row). |
| `MC_LIVE_TOKEN_INTERNAL` | Internal non-admin. |
| `MC_LIVE_TOKEN_INTERNAL_ACCOUNTING` | Internal accounting. |

Optional: `MC_LIVE_TOKEN_ARTIST_2` (a second artist), `MC_LIVE_DEPLOYMENT` (`supabase` or `aws`,
to check the union branch), `MC_LIVE_INVITEE_EMAIL` (with `{n}`; default
`cross-cloud-invitee-{n}@example.com`), `MC_LIVE_PROCESSING_TIMEOUT_SECONDS` (default 900),
`MC_LIVE_POLL_SECONDS` (default 5), `MC_LIVE_REPORT` (a file for the JSON report).

To compare two deployments, run it once against each with `MC_LIVE_REPORT`, then:

```bash
node tests/cross-cloud/run-live.ts --compare supabase.json aws.json
```

How it stays safe:

- it never prints a token, and the report holds none;
- it refuses to start when a required variable is missing (exit 2), and says so plainly when the
  deployment does not answer (exit 3): a free Supabase project pauses after about a week without
  use;
- it changes only what it creates: its own releases (each taken down at the end), their uploads,
  parties and plays. Every refused call uses its own release ids;
- masters are WAVs of at most 50 MiB (the free project's limit, settled), made with ffmpeg.

What it cannot check on a real deployment, and skips with the reason: accepting invitations (the
codes are only in the emails), firing the go-live schedule (it runs at 00:00 UTC on the release
date; the first release stays `scheduled` and is taken down), counting qualified streams (and
moving a play's receive times back 31 seconds, which a play needs to count since session J1), the
storage and audit rows after a takedown, the sweep's late pass (it runs 2 hours or more after the
takedown), and the suspended or removed accounts. The mocks check all of those.

Needs Node 22.18 or newer, ffmpeg, and `npm ci` in `tests/cross-cloud/` (it reads the contract
with `yaml`).

You are session F of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to D are merged. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and your section, "F: AWS deployment")
2. `api/openapi.yaml` (the contract, 21 operations; the table of release state moves is at the top)
3. `core/src/platform/` (the eight interfaces; you implement all of them for AWS)
4. `db/` (session B's migrations, tests and README) and `db/account-claim.json` (session C: the claim, the Cognito group names and precedence)

Your job: the AWS deployment. Implement each platform interface on AWS, and the entry point wiring for Lambda. Session E does the same for Supabase, and session G writes the shared handlers. Don't write handlers.

### Build (each one a module that implements its interface in `core/src/platform/`)
- Identity: who is calling, from the Cognito token (verify it against the pool's published keys). The `account_type` claim comes from Cognito groups named in `db/account-claim.json` (session C): `administrator`, `internal`, `internal_accounting`, `third_party` and `artist`, with Cognito precedence 1 to 5 in that order. There is no `end_user` group; no group means `end_user`. If a user is ever in more than one group, take the one with the lowest precedence number. Return null for no valid token.
- The account source on AWS (settled): session B's `api_accounts` table is the one source. Build a Cognito post-confirmation trigger that writes the user's email into their `api_accounts` row where one exists, and a small sync that puts each user in the Cognito group named by their `api_accounts.account_type` (and removes other groups). Rows are written by K Marcus or a later admin tool, not by users.
- Object storage:
  - Upload session method `s3_multipart`: S3 presigned multipart. Masters are WAV, AIFF or FLAC, up to 5 GiB, stored at `masters/{artist}/{release}/{track}/original` and never altered. Store keys, never public URLs.
  - Progress and resume: list the parts already stored so an interrupted upload picks up where it stopped. Sign more parts on request (they expire).
  - Confirm: complete the multipart upload with the client's part ETags, and check the full-object CRC64NVME and the stored size (a mismatch is `checksum_mismatch`, and the upload stays open). A multipart SHA-256 in S3 is a checksum of the parts, so it cannot equal the client's whole-file SHA-256; the worker checks that while it streams the master (settled; session H builds it). Say what that costs for 5 GiB in the pull request.
  - Sign a read: playback method `cloudfront_cookies`, CloudFront signed cookies for that listener plus the stream address. Keep them short-lived.
  - Cover art: the same `s3_multipart` session for a `jpeg` or `png` up to 20 MiB at `art/{artist}/{release}/cover/original`; a read for the cover uses the same `signRead` as playback.
  - `readHead`: the first bytes of an object, as a ranged GET (session G reads a cover's width and height with it).
  - Playback signs only streaming copies under `streams/{artist}/{release}/{track}/`, never `masters/`; scope the cookies to one track's prefix.
  - Delete everything under a prefix (used by takedown).
- Jobs: queue a job and report its result. The worker runs on Fargate. Build the queue, the worker skeleton (picks up a `process_release` job, reports success or a plain-words failure) and the result path. Jobs are rows in session B's jobs table. `reportResult` passes the result to session G's job-result function, which moves the release state; wire it once G states the path, and list it as an open point until then. What processing actually does to a master is not decided; don't invent it. List it as an open point.
- Schedules: run a SQL function at a time, with EventBridge Scheduler calling the RDS Data API (one-time schedules that delete themselves after running; setting the same name again replaces it).
- Server functions: a generic Lambda adapter on Node 22, behind API Gateway, that turns the request event into a web-standard `Request`, calls a shared handler with the modules, and turns the `Response` back. Keep it small. The one-entry-point-per-operation files wait until session G's handlers exist; don't guess their path. List it as an open point.
- Secrets and email: get a secret by name (Secrets Manager or Parameter Store; pick the simpler one and say why) and send the templates named in `secrets-email.ts` through SES.
- Database: the RDS Data API behind the `Database` interface. Translate `$1`, `$2` parameters into the Data API's form, carry transactions through its transaction id, and handle its limits (1 MB per response, 45 seconds per call). Never build SQL by joining values into text.
- Infrastructure: stand up, confirm, tear down, as an infrastructure definition plus a script K Marcus runs (Aurora PostgreSQL with the Data API on, Cognito pool and groups, S3 bucket with the checksum setting, CloudFront with a key group, API Gateway, Lambda, SQS or equivalent, Fargate, EventBridge Scheduler, SES, IAM). Propose the simplest definition tool that fits (CDK, Terraform, SAM or plain CloudFormation), say why, and list the choice as an open point. You write it; you do not run it against anything real.

### From session B (merged; handle these)
- **Applying the migrations.** Each file in `db/migrations/` holds several statements and `$$` function bodies, and the Data API runs one statement per call. The stand-up applies the files in number order, each one whole, by one of two routes:
  - `psql` over a temporary connection
  - a splitter that respects dollar quotes and comments, with a test over every current migration file

  Say which you chose and why. Don't edit B's files. Apply only `db/migrations/`, never `db/supabase/`.
- **Calling B's functions through the Data API** (see `db/README.md`):
  - Cast parameters in the SQL text (`$1::uuid`, `$2::jsonb`, `$3::timestamptz`).
  - Pass lists as JSON text.
  - Read `numeric`, `bigint`, `date`, `timestamptz` and `jsonb` results as strings.
  - B's rules raise SQLSTATE `MC403`, `MC404`, `MC409` and `MC422` with a code word at the start of the message. Your `Database` must surface the SQLSTATE and message so G can map them to HTTP codes. Test it with a mocked Data API error.
- **Schedules.** The go-live function is `api_release_go_live` with the named argument `p_release_id`. It moves only `scheduled` → `live` and does nothing otherwise, so a schedule that fires after a takedown is harmless.
- **Jobs.**
  - `enqueue` creates the row with `api_create_job(release, 'process_release')`; the release must be `processing`.
  - The worker calls `api_job_started(job)` when it picks the job up.
  - The result goes through G's function to `api_apply_job_result`, which is safe to call twice.
- **Takedown storage.** `api_takedown_release` returns the prefixes to delete. After `ObjectStorage.delete` succeeds for each, call `api_takedown_files_deleted(audit)`.
- **The account sync.**
  - The post-confirmation trigger only updates `email` on an existing `api_accounts` row; it never inserts one.
  - An artist row never changes type.
  - An account with releases, reviews or takedowns is never deleted. It is `suspended` instead (B refuses the delete with `MC409 has_history`).
  - A suspended account's claim is `end_user` (settled with session C), so the sync puts a suspended account in no group.

### From session C (merged; handle these)
- **The claim.** `db/account-claim.json` is the definition. Test your group mapping against it: each group name, no group, a suspended row, and two groups at once.
- **Supabase-only SQL.** `db/supabase/` never runs on Aurora. Aurora has one shared login, so G's handlers are the only read check there.
- **Staff rows (settled).** G's handlers check the caller's `api_accounts` row on staff endpoints as well as the token, so a removed staff role stops at once even before the Cognito token expires. Still remove the user from the group when the row changes.

### From session D (merged; CI)
- Every pull request into `milk-crate-backend-poc` runs "Phase 0 checks" (`.github/workflows/phase0-checks.yml`). Six checks must pass before it can merge: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests` and `database`.
- Run them yourself before you push. From the repository root: `bash db/test/run.sh`. From `milk-crate/`: `npm ci`, `npm run api:lint`, `npm run api:client` (then `git diff --exit-code src/lib/api/schema.d.ts` must be empty), `npm run api:core`, `npx tsc --noEmit` and `npm test`.
- `client-fresh` fails if `milk-crate/src/lib/api/schema.d.ts` no longer matches `api/openapi.yaml`. The contract is fixed, so this matters only if K Marcus approves a contract change: then run `npm run api:client` and commit the result.
- `database` runs when `db/**`, `milk-crate/supabase/**`, `api/openapi.yaml`, `core/src/platform/types.ts` or the workflow changes. If your change makes it fail, fix it on your branch.
- The checks start only for changes under `api/`, `core/`, `db/` and `milk-crate/`. A change only under `deploy/aws/` skips them (a skipped check counts as passed), and nothing runs your tests in CI until their job is added.
- Don't edit `.github/workflows/`. Give your tests one documented command that runs from a clean checkout, with no keys and no network beyond package installs. In your pull request, list the CI job you want added: the command, the paths that should start it, and anything it must install. A session D follow-up adds it.

### Constraints
- No real AWS account, no real resources, no keys. Code, infrastructure definition and a script are the deliverable. Tests use mocks.
- This environment has PostgreSQL 16 (no Docker daemon, no AWS access). The Data API has no local emulator, so test the parameter translation, transaction handling and result mapping with mocks, and rely on session B's tests for the SQL itself. Mock S3, CloudFront, SQS, ECS, EventBridge and SES at their SDK edges and check each with a test. Say what you could not run.
- Put your code under a new top-level folder, `deploy/aws/`. No platform SDK imports in `core/`; the AWS SDK lives only in your folder.
- Upload session shape and playback shape are the contract's: `s3_multipart` and `cloudfront_cookies`. Don't change them.
- Don't change the app's existing tables, policies, screens or Supabase calls.
- Don't write handlers (session G), read rules or the claim source (session C), CI (session D), or Supabase code (session E).

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/f-aws`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret. Where a real credential is needed, write what is needed and stop.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- Every interface has an AWS implementation with tests that pass against mocks (`core/` and `milk-crate/` type-check, and `cd milk-crate && npm test` still passes).
- The infrastructure definition, stand-up script and tear-down are ready for K Marcus to run, and nothing in them needs a secret in the repository.
- The pull request description lists: what you built, what you ran and its result, what you could not run here, the open points for K Marcus (at least: the cost of the worker's SHA-256 check, processing work, entry points waiting on session G, the infrastructure tool), and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

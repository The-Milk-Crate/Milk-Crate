# Phase 0: briefs for sessions B to I

Session A wrote the contract (`api/openapi.yaml`) and the platform interfaces
(`core/src/platform/`). Sessions B to I build on them. Phase 0 is a backend proof of
concept for release publishing and plays, on two deployments from one codebase:
**Supabase** and **AWS**. Anything that runs on one must run on the other.

Paste the shared rules and your own section into your session, or paste the ready-made kickoff
prompt for your session from `docs/phase0-prompts/` (index below).

## Shared rules (every session)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/<letter>-<topic>`.
  Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge
  any pull request (including your own), never change repository settings, rulesets,
  environments or secrets. (Session D may edit `.github/workflows/`. Nobody else may.)
- You get no keys, tokens or passwords. Never print or commit a secret. Where a real
  credential is needed, write what is needed and stop.
- `build.yml` publishes a desktop release on every push to `main`. Nothing may need a change to it.
- Don't change the desktop app's screens or its existing Supabase calls. The app keeps
  calling Supabase directly for everything outside this slice until Phase 1.
- The contract is fixed. If you need it to change, don't edit it. Write the change and the
  reason in your pull request as an open point for K Marcus.
- `core/` has no runtime dependencies and imports no platform SDK. Handlers take web-standard
  `Request` and `Response` and receive their modules as arguments.
- Ask before deciding anything this brief doesn't cover. List open points in the pull
  request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.
- Your pull request lists what you built, what you ran and its result, open points, and assumptions.
  Then stop. K Marcus and a separate review agent review it.

## What exists
- Contract: `api/openapi.yaml` (21 operations). Lint: `cd milk-crate && npm run api:lint`.
  The table of release state moves is at the top of the file.
- Interfaces: `core/src/platform/` (the seven modules: identity, storage, jobs, schedules,
  server functions, secrets and email, infrastructure; an eighth, `Database`; plus
  `PlaybackGrant` and shared types).
  Check: `cd milk-crate && npm run api:core`.
- Generated client: `milk-crate/src/lib/api/`. Regenerate: `cd milk-crate && npm run api:client`.

## Order
B first. D can start with B. C starts when B's pull request is merged, because its read rules
protect B's tables. E, F and G (stage 1) start when B's pull request is merged. H and G's
stage 2 (the cross-cloud check) run last: H needs E, F and G stage 1 merged, and G stage 2 needs
E, F and G stage 1 merged. I runs after everything else is merged and before the live stand-up.

| Session | Owns |
|---|---|
| B | Database |
| C | Read rules and the account-type claim |
| D | CI |
| E | Supabase deployment |
| F | AWS deployment |
| G | Shared core handlers (stage 1) and the cross-cloud check (stage 2) |
| H | Processing work: what happens to a master while a release is `processing` |
| I | Security and abuse review of the merged work (report only; no fixes) |

## Kickoff prompts
| Session | Prompt |
|---|---|
| A (done) | `docs/phase0-prompts/a-contract.md`. The original brief, as first given. The contract has changed since: see `api/openapi.yaml`. |
| B | `docs/phase0-prompts/b-database.md` |
| C | `docs/phase0-prompts/c-read-rules.md` |
| D | `docs/phase0-prompts/d-ci.md` |
| E | `docs/phase0-prompts/e-supabase.md` |
| F | `docs/phase0-prompts/f-aws.md` |
| G stage 1 | `docs/phase0-prompts/g1-core.md` |
| G stage 2 | `docs/phase0-prompts/g2-cross-cloud.md` |
| H | `docs/phase0-prompts/h-processing.md` |
| I | `docs/phase0-prompts/i-security-review.md` |

If a prompt and a section below disagree, the prompt is newer; tell K Marcus.

## B: Database
Branch `phase0/b-database`.
- One schema that runs on Supabase Postgres and Aurora PostgreSQL: releases, tracks,
  uploads, rights and parties, review decisions, play events, qualified streams, audit rows.
- The release state enum and the rule that only the server moves a state. Match the
  state table in the contract. Approve does not change the state; it records
  `review.decision = approved`.
- Rights: parties with side (recording or composition), role, name, email, percent and state
  (invited, accepted, declined). Shares for each side must total 100 at submit.
- Split invite codes (settled): store only a hash of the code, with `expires_at` set to 14 days
  after the invitation is sent, plus `used_at`. A code works once. `resendInvitation` replaces
  the hash and expiry, so the old code stops working. Count sends per party per day. Never
  store or return the code itself. Also count wrong code
  attempts per party (for `getInvitation` and `respondToSplit` rate limits). Session G checks all three in one transaction.
- The invitation read: a narrow SQL function for `getInvitation` that takes the release id, the
  party id and the code's hash and returns only the contract's `Invitation` fields, without
  using up the code and without exposing other parties, emails or `owner_id`.
- The account source (settled): one portable table, `api_accounts` (not the app's
  `public.accounts`), with `user_id` (the identity's user id: the Supabase user id or the
  Cognito `sub`; primary key), `account_type` (any `AccountType` but `end_user`), `email`, and
  `artist_id` and `artist_name` (set only for `artist`). One row per account, so one role per
  account; no row means `end_user`. A row cannot change to or from `artist`. An account with
  history is suspended (`suspended`), never deleted.
  Both claims read this table. B's SQL never references `auth.*`, `public.admins`,
  `public.artists` or any other app table, so it runs on Aurora and plain Postgres. Session C
  fills it on Supabase from the app's tables; session F fills it on AWS.
- A jobs table: job id, release, kind, state, times and the failure message, so a job result
  finds its release.
- Per track, nullable columns for what playback needs (streaming copy key, duration, sample
  rate). Session H fills them; G's `getPlayback` reads the key.
- Play events: a batch with the same idempotency key counts once. The server decides what
  is a qualified stream (30 seconds or more). The client never sends counts.
- Cover art (`art/{artist}/{release}/cover/original`), `kind` on uploads, editable states for a
  release's details and track order, and a list query (summaries, newest first, state filter,
  keyset cursor paging).
- Master keys follow `masters/{artist}/{release}/{track}/original`. Store keys, never public URLs.
- SQL functions the schedules and handlers call, such as "make this release live on its date".
  That one moves only `scheduled` → `live` and does nothing in any other state (a taken-down
  release must not come back; `Schedules` cannot cancel a run).
- Audit rows for takedown, listing what was removed.
- Write SQL that works through `Database` on both sides: parameters as `$1`, `$2`, no
  Postgres-only client features. Keep each call's result small (RDS Data API: 1 MB, 45 seconds).
- Where things go (settled): migrations in `db/migrations/` at the repository root, as numbered
  plain SQL files (`0001_...sql`). The test and `db/README.md` in `db/test/` and `db/`. Not in
  `milk-crate/supabase/`, which is the app's own hand-run SQL. `db/migrations/` runs on both
  deployments. Supabase-only SQL (session C's) goes in `db/supabase/`, applied after
  `db/migrations/` on Supabase only.
- Migrations are safe to run twice. The test uses a throwaway local PostgreSQL 16 and no Docker:
  a script starts a temporary cluster (`initdb` and `pg_ctl` as the `postgres` user, on a temp
  directory and a free port), applies every migration twice, runs the checks, then stops the
  cluster and removes the directory, even when a check fails. No keys and no network. Checks:
  state rules, the 100-percent rule, idempotent play batches, single-use invite codes, and one
  role per account in `api_accounts`. Keep it free of anything specific to one machine, because session D
  runs the same script in CI.
- Don't write read rules or the claim hook (session C), handlers (session G), or deployment code
  (sessions E and F). Don't change the app's existing tables or policies; add alongside them.

Done when: the migrations apply cleanly to an empty Postgres, twice, and the tests pass; `db/test/`
runs from a clean checkout with one documented command and leaves nothing behind; and every table
and state in the contract has a home.

## C: Read rules and the account-type claim
Branch `phase0/c-read-rules`.
- The `account_type` claim, one name and the values in `AccountType`. Supabase: a custom
  access token hook. AWS: Cognito groups with the same names.
- Who enforces reads (settled). On both deployments G's handlers enforce access in every
  query, passing the caller. On Supabase, row level security on B's tables also guards direct
  table access (the app talks to Supabase directly). Aurora has one shared login, so it has no
  per-caller rules. C writes the expected-results table (account type by what it may read) as
  a shared test fixture that C's Supabase tests and G's handler tests both use.
  Listeners see only `live` releases. Public views hide `owner_id`. An artist sees only their
  own. Reviewers see what the contract says they see.
- Where it goes (settled): everything Supabase-only (the hook, row level security, the sync
  below) in `db/supabase/`, never in `db/migrations/` or `milk-crate/supabase/`. C's tests
  may stand up a minimal test-only `auth` stand-in to load the app's SQL on plain Postgres.
- Source of the claim (settled): session B's `api_accounts` (use it; do not create it). On
  Supabase, C keeps it in step with the app's tables: every `public.admins` row means
  `administrator`; an account with an approved artist profile (what `is_approved_artist()`
  checks today) gets `artist` with its profile id and name. `internal`, `internal_accounting`
  and `third_party` rows are written directly. No row means `end_user`, so pending and declined
  applicants stay `end_user` until a reviewer approves them. On AWS, session F fills it and puts
  each Cognito user in the group of the same name. Don't change the app's existing tables or
  policies; add alongside them.
- One role per account (settled). Staff types and `artist` are mutually exclusive: one
  `api_accounts` row per account, and B refuses changing a row to or from `artist`. C's sync
  refuses an approval or an admins row that would give an account a second role. A staff member who makes music uses a second account. This also
  means nobody reviews their own release. If the app's tables ever hold both anyway, the sync
  takes the higher-privilege type (`administrator`, `internal`, `internal_accounting`,
  `third_party`, `artist`, `end_user`, in that order) and the artist endpoints refuse them.
  Test both cases.
- Removing a role: an account with releases, reviews or takedowns is suspended, not deleted (B
  refuses the delete). C decides which claim a suspended account gets (suggested: `end_user`).
- The claim is read when the token is issued, so a role change shows after the token refreshes.
  Say so in your tests and notes.
- From B (merged): on Supabase, B's `api_` tables and functions get the default grants to `anon`
  and `authenticated`. Turn on row level security on every `api_` table and revoke those grants,
  then grant back only what is needed. `api_respond_to_invite` takes a user id, so clients get
  only a wrapper that passes `auth.uid()`. Details in `docs/phase0-prompts/c-read-rules.md`.
- Listing and covers: an artist lists only their own releases; staff list all; a cover reads like
  playback (owner and staff any state, everyone else only when `live`).
- The invitee path: don't open the tables to invitees. Allow only B's narrow invitation function
  (and the write that records a reply). Test a valid code, a wrong code and an expired code.
- Tests that sign in as each account type and check what each can read.

Done when: tests prove each account type reads only what the contract allows under the
Supabase rules, and the expected-results fixture is ready for G's handler tests.

## D: CI
Branch `phase0/d-ci`. The only session that may edit `.github/workflows/`.
- New workflow files only. Don't edit `build.yml` or `pages.yml`.
- On pull requests: lint the contract, type-check `core/` and `milk-crate/`, run
  `cd milk-crate && npm test`, regenerate the client and fail if `schema.d.ts` is stale.
- Run B's database test, `bash db/test/run.sh` (it starts its own throwaway PostgreSQL 16
  cluster; no Postgres service). Later, E's and F's tests.
- No secrets in workflows for this phase. Deploy jobs wait for K Marcus.

Done when: a pull request that breaks the contract, the types or the tests goes red, and a
clean one goes green. `build.yml` is untouched.

## E: Supabase deployment
Branch `phase0/e-supabase`.
- Implement each platform interface on Supabase: identity from the token, storage (TUS
  resumable uploads and signed links unique to the listener), jobs (worker on Fly Machines),
  schedules (pg_cron), server functions (Edge Functions on Deno), secrets and email,
  infrastructure (stand up, confirm, tear down), and `Database` over a Postgres connection
  (pooled, with transactions).
- Upload session method `tus`; playback method `signed_url`. `readHead` is a ranged read.
- Stand-up applies `db/migrations/`, then `db/supabase/`.
- `Jobs.reportResult` passes the result to G's job-result function (wire it once G states the path).
- Supabase Storage keeps no SHA-256 of an object and an Edge Function cannot hash 5 GiB. Say
  plainly how the client's SHA-256 is checked and what it costs (open point; see session H).
- Don't create real projects or use real keys. Provide the code, config and a script K Marcus
  runs. Tests use local Supabase or mocks.
- Edge Function entry points call G's handlers and only do wiring.
- From B (merged):
  - `Database` surfaces B's SQLSTATEs (`MC403`, `MC404`, `MC409`, `MC422`).
  - pg_cron runs `api_release_go_live` with `p_release_id`.
  - Jobs use `api_create_job` and `api_job_started`.
  - The server's connection uses a role that keeps access after C revokes the default grants.

  Details in `docs/phase0-prompts/e-supabase.md`.

Done when: the interface tests pass against local Supabase or mocks, and the stand-up script
is ready for K Marcus to run.

## F: AWS deployment
Branch `phase0/f-aws`.
- Implement each platform interface on AWS: identity from Cognito, storage (S3 presigned
  multipart with CRC64NVME, CloudFront signed cookies plus the stream address), jobs (worker
  on Fargate), schedules (EventBridge Scheduler calling the RDS Data API), server functions
  (API Gateway and Lambda on Node 22), secrets and email, infrastructure (stand up, confirm,
  tear down), and `Database` over the RDS Data API (parameters, transactions through its
  transaction id, results paged under its 1 MB limit).
- Upload session method `s3_multipart`; playback method `cloudfront_cookies`. `readHead` is a
  ranged GET.
- The account source on AWS: a Cognito post-confirmation trigger writes the user's email to
  `api_accounts` where a row exists, and a small sync puts each user in the Cognito group named
  by their `api_accounts.account_type` (no group means `end_user`). A suspended account goes in
  no group until C decides its claim.
- From B (merged): the Data API runs one statement per call and B's migration files hold several,
  with `$$` bodies, so the stand-up applies each file whole with `psql` or with a tested splitter.
  `Database` surfaces B's SQLSTATEs (`MC403`, `MC404`, `MC409`, `MC422`). Details in
  `docs/phase0-prompts/f-aws.md`.
- `Jobs.reportResult` passes the result to G's job-result function (wire it once G states the path).
- An S3 multipart SHA-256 is a checksum of the parts, so it cannot equal the client's whole-file
  SHA-256. Say plainly how it is checked and what it costs (open point; see session H).
- Propose the simplest infrastructure definition tool (CDK, Terraform, SAM or CloudFormation)
  and list the choice as an open point.
- Don't create real resources or use real keys. Provide the code, infrastructure definition
  and a script K Marcus runs. Tests use mocks or local emulators.
- Lambda entry points call G's handlers and only do wiring.

Done when: the interface tests pass against mocks or emulators, and the stand-up script is
ready for K Marcus to run.

## G: Shared core handlers and the cross-cloud check
Branch `phase0/g-core` (stage 1) and `phase0/g-cross-cloud` (stage 2).

Stage 1:
- One handler per operation in `core/`, using `Request`, `Response` and the modules from
  `Modules`. Reach the database only through `Database`, with parameters and a transaction
  wherever more than one write must go together. Errors use the one `Error` shape. Enforce the
  account types and state moves in the contract, and the read access on both deployments
  (pass the caller in every query; test with C's expected-results fixture once C is merged).
- Owner emails come from `api_accounts.email`. Playback signs only the streaming copy key
  B stores per track, under `streams/{artist}/{release}/{track}/`.
- A small router, and a function that applies a worker's job result (the contract has no HTTP
  operation for it). State the handlers' path at the top of the pull request: E and F wait on it.
- Unit tests with fake modules, and session B's throwaway Postgres for paths that run SQL. The
  same handler code runs on Deno and Node.

- From B (merged): call B's functions and map their results, rather than rebuilding the checks.
  - B checks invite codes, counts wrong codes and locks a party after 10 an hour. Map its
    statuses to HTTP codes.
  - Map B's SQLSTATEs (`MC403`, `MC404`, `MC409`, `MC422`) to the same HTTP codes.
  - The owner's own party (`is_owner`) gets no invitation. A changed party needs a new one.
  - Refuse suspended accounts.

  Details in `docs/phase0-prompts/g1-core.md`.

Stage 2 (after E, F and G stage 1 are merged):
- A suite that runs the same scenario against both deployments' module sets (create a release,
  upload a master, resume it, add splits, submit, review, publish, play, take down) and checks
  they behave the same, plus a script K Marcus can run against real deployments with
  environment variables. Differences are reported as findings, not fixed.

Done when: every operation has a handler and tests (stage 1); the scenario passes on both
module sets, or every difference is listed (stage 2).

## H: Processing work
Branch `phase0/h-processing`. Not in the original plan; added because processing was left open.
- One shared worker and one container image for Fly Machines and Fargate.
- Per track: read the master as a stream, check it, hash it (the client's SHA-256), make the
  streaming copy, and record what playback needs. The master is never altered. Safe to run twice.
- Settled: streaming copies live under `streams/{artist}/{release}/{track}/` (H picks the file
  names inside). The worker checks the client's SHA-256 while streaming the master; a mismatch
  fails the release with a plain reason. Record the streaming key, duration and sample rate in
  B's track columns.
- Before building, ask K Marcus: streaming format and bitrate, what makes a master bad, sonic
  analysis and cover sizes in or out, and the storage interface addition.
- `ObjectStorage` has only `readHead` (small ranged reads), no stream read or write for a worker.
  With K Marcus's approval only, add the smallest addition in `core/` and in the storage modules
  of E and F.
- From B (merged): record `stream_key`, `duration_ms` and `sample_rate_hz` on `api_tracks`;
  compare against `api_tracks.master_sha256`; call `api_job_started` when a job is picked up.

Done when: every track is checked, hashed and turned into a streaming copy by one shared piece,
and the release reaches `awaiting_splits` or `failed` through the job result path.

## I: Security and abuse review
Branch `phase0/i-security-review`. Not in the original plan. Run it after every other session
(B to H, and G stage 2) is merged and before the live stand-up, so fixes land before anything is
reachable.
- A read-only review of the merged work against 14 areas (authentication, authorization against
  the contract, the account-type claim, the state machine, invitations, uploads and keys, reads,
  plays, takedown, injection, secrets and configuration, rate limits, dependencies and workflows,
  the desktop client).
- It adds one file, `docs/security/review-phase0.md`, with findings ranked by severity, marked
  `confirmed` or `suspected`, with the owning session for each fix, plus what could not be checked
  without real accounts. It fixes nothing.

Done when: every area has findings or a "checked, nothing found" line, and the report is the only
file added.

## Settled before work starts
- **Database access.** An eighth interface, `Database` (`query` and `transaction`), in
  `core/src/platform/database.ts`. Supabase uses a Postgres connection; AWS uses the RDS Data API.

- **Reviewer claim mapping.** As written in session C above.

- **More than one role.** Not allowed. As written in session C above.

- **Settled with session B.**
  - `third_party` is not staff, and an `artist` row never changes type.
  - The release owner's own party (`is_owner`) is accepted at once, with no code. Every other
    party replies only by using up a code.
  - After 10 wrong codes in an hour, a party's invitation is locked inside the database.
  - Accounts with history are suspended, never deleted.
  - Release dates are UTC dates.
  - The qualified-stream rule stays as built for Phase 0.

- **Who is "the invited person".** An invite code. The invitation email carries a single-use,
  expiring code (`inviteCode`). The invitee signs in with any non-staff account (`end_user`,
  `artist` or `third_party`) and sends the code to
  `respondToSplit`; the account that replies is linked to the party. The invited email does
  not have to match. Store only a hash of the code. Never return the code from any endpoint.
  Session B holds the hash, expiry (14 days) and used-at; session G checks them in one transaction.

- **Invitee view.** A new endpoint, `getInvitation`: the invitee sends the code in a POST body and
  sees the release basics and only their own share. It does not use up the code. Wrong or
  expired code is 403; wrong codes are rate limited (429), counted per party together with
  `respondToSplit`'s. Session G builds it.

- **Resending an invitation.** A new endpoint, `resendInvitation`: release owner only, party
  must be `invited`, issues a new 14-day code and voids the old one, limited per party per day.

- **Account source.** One portable table, `api_accounts`, owned by session B; see B and C.

- **Supabase-only SQL.** In `db/supabase/`, applied after `db/migrations/` on Supabase only.

- **Who enforces reads.** G's handlers, on both deployments. Supabase row level security also
  guards direct table access. See C.

- **Leaving `failed`.** The artist replaces a master with `startUpload` (`failed` → `uploading`).

- **The SHA-256 check.** Confirm checks the size (and CRC64NVME on S3); the worker checks the
  SHA-256 while streaming the master. A mismatch fails the release with a plain reason.

- **Streaming copy keys.** Under `streams/{artist}/{release}/{track}/`. Playback never signs a
  master. Takedown deletes the release's `masters/`, `streams/` and `art/` prefixes.

- **Cover check.** `ObjectStorage.readHead` gives G the first bytes of a cover to read its
  width and height.

## Open before work starts
None.

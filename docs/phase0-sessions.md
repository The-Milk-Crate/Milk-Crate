# Phase 0: briefs for sessions B to G

Session A wrote the contract (`api/openapi.yaml`) and the platform interfaces
(`core/src/platform/`). Sessions B to G build on them. Phase 0 is a backend proof of
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
E, F and G stage 1 merged.

| Session | Owns |
|---|---|
| B | Database |
| C | Read rules and the account-type claim |
| D | CI |
| E | Supabase deployment |
| F | AWS deployment |
| G | Shared core handlers (stage 1) and the cross-cloud check (stage 2) |
| H | Processing work: what happens to a master while a release is `processing` |

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
- The staff table `(user_id, account_type)` for `internal`, `internal_accounting` and
  `third_party`, with the staff and `artist` exclusion enforced in the database. Every
  `public.admins` row means `administrator`. Session C writes the claim hook and read rules.
- Play events: a batch with the same idempotency key counts once. The server decides what
  is a qualified stream (30 seconds or more). The client never sends counts.
- Cover art (`art/{artist}/{release}/cover/original`), `kind` on uploads, editable states for a
  release's details and track order, and a list query (summaries, newest first, state filter,
  keyset cursor paging).
- Master keys follow `masters/{artist}/{release}/{track}/original`. Store keys, never public URLs.
- SQL functions the schedules and handlers call, such as "make this release live on its date".
- Audit rows for takedown, listing what was removed.
- Write SQL that works through `Database` on both sides: parameters as `$1`, `$2`, no
  Postgres-only client features. Keep each call's result small (RDS Data API: 1 MB, 45 seconds).
- Where things go (settled): migrations in `db/migrations/` at the repository root, as numbered
  plain SQL files (`0001_...sql`). The test and `db/README.md` in `db/test/` and `db/`. Not in
  `milk-crate/supabase/`, which is the app's own hand-run SQL.
- Migrations are safe to run twice. The test uses a throwaway local PostgreSQL 16 and no Docker:
  a script starts a temporary cluster (`initdb` and `pg_ctl` as the `postgres` user, on a temp
  directory and a free port), applies every migration twice, runs the checks, then stops the
  cluster and removes the directory, even when a check fails. No keys and no network. Checks:
  state rules, the 100-percent rule, idempotent play batches, single-use invite codes, and the
  staff and artist exclusion. Keep it free of anything specific to one machine, because session D
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
- Read rules (row level security on Supabase; the equivalent checks on Aurora) for the tables
  from B. Listeners see only `live` releases. Public views hide `owner_id`. An artist sees
  only their own. Reviewers see what the contract says they see.
- Source of the claim (settled): every `public.admins` row maps to `administrator`. Session B's
  staff table `(user_id, account_type)` (use it; do not create it) holds `internal`, `internal_accounting` and
  `third_party`. An account with an approved artist profile (what `is_approved_artist()` checks
  today) gets `artist`. Everyone else is `end_user`. Pending and declined applicants stay
  `end_user` until a reviewer approves them. The Supabase hook and the AWS Cognito groups
  read the same source. Don't change the app's existing tables or policies; add alongside them.
- One role per account (settled). Staff types and `artist` are mutually exclusive, enforced in the
  database: a staff row cannot be added for an account with an approved artist profile, and
  an artist cannot be approved for an account with a staff row. A staff member who makes music
  uses a second account. This also means nobody reviews their own release. If both ever exist
  anyway, the claim takes the higher-privilege type (`administrator`, `internal`,
  `internal_accounting`, `third_party`, `artist`, `end_user`, in that order) and the artist
  endpoints refuse them. Test both cases.
- The claim is read when the token is issued, so a role change shows after the token refreshes.
  Say so in your tests and notes.
- Listing and covers: an artist lists only their own releases; staff list all; a cover reads like
  playback (owner and staff any state, everyone else only when `live`).
- The invitee path: don't open the tables to invitees. Allow only B's narrow invitation function
  (and the write that records a reply). Test a valid code, a wrong code and an expired code.
- Tests that sign in as each account type and check what each can read.

Done when: tests prove each account type reads only what the contract allows, on both
deployments' rule sets.

## D: CI
Branch `phase0/d-ci`. The only session that may edit `.github/workflows/`.
- New workflow files only. Don't edit `build.yml` or `pages.yml`.
- On pull requests: lint the contract, type-check `core/` and `milk-crate/`, run
  `cd milk-crate && npm test`, regenerate the client and fail if `schema.d.ts` is stale.
- Later: run B's migration tests against a Postgres service, and E's and F's tests.
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
- Upload session method `tus`; playback method `signed_url`.
- Supabase Storage keeps no SHA-256 of an object and an Edge Function cannot hash 5 GiB. Say
  plainly how the client's SHA-256 is checked and what it costs (open point; see session H).
- Don't create real projects or use real keys. Provide the code, config and a script K Marcus
  runs. Tests use local Supabase or mocks.
- Edge Function entry points call G's handlers and only do wiring.

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
- Upload session method `s3_multipart`; playback method `cloudfront_cookies`.
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
  account types and state moves in the contract.
- A small router, and a function that applies a worker's job result (the contract has no HTTP
  operation for it). State the handlers' path at the top of the pull request: E and F wait on it.
- Unit tests with fake modules, and session B's throwaway Postgres for paths that run SQL. The
  same handler code runs on Deno and Node.

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
- Before building, ask K Marcus: streaming format and bitrate, derived-file key layout, what makes
  a master bad, the SHA-256 check, sonic analysis and cover sizes in or out, and the storage interface addition.
- `ObjectStorage` has no read or write for a worker. With K Marcus's approval only, add the
  smallest addition in `core/` and in the storage modules of E and F.

Done when: every track is checked, hashed and turned into a streaming copy by one shared piece,
and the release reaches `awaiting_splits` or `failed` through the job result path.

## Settled before work starts
- **Database access.** An eighth interface, `Database` (`query` and `transaction`), in
  `core/src/platform/database.ts`. Supabase uses a Postgres connection; AWS uses the RDS Data API.

- **Reviewer claim mapping.** As written in session C above.

- **More than one role.** Not allowed. As written in session C above.

- **Who is "the invited person".** An invite code. The invitation email carries a single-use,
  expiring code (`inviteCode`). The invitee signs in with any account and sends the code to
  `respondToSplit`; the account that replies is linked to the party. The invited email does
  not have to match. Store only a hash of the code. Never return the code from any endpoint.
  Session B holds the hash, expiry (14 days) and used-at; session G checks them in one transaction.

- **Invitee view.** A new endpoint, `getInvitation`: the invitee sends the code in a POST body and
  sees the release basics and only their own share. It does not use up the code. Wrong or
  expired code is 403; wrong codes are rate limited (429). Session G builds it.

- **Resending an invitation.** A new endpoint, `resendInvitation`: release owner only, party
  must be `invited`, issues a new 14-day code and voids the old one, limited per party per day.

## Open before work starts
None.

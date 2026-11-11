# Phase 0: briefs for sessions B to G

Session A wrote the contract (`api/openapi.yaml`) and the platform interfaces
(`core/src/platform/`). Sessions B to G build on them. Phase 0 is a backend proof of
concept for release publishing and plays, on two deployments from one codebase:
**Supabase** and **AWS**. Anything that runs on one must run on the other.

Paste the shared rules and your own section into your session.

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
- Contract: `api/openapi.yaml` (16 operations). Lint: `cd milk-crate && npm run api:lint`.
  The table of release state moves is at the top of the file.
- Interfaces: `core/src/platform/` (the seven modules: identity, storage, jobs, schedules,
  server functions, secrets and email, infrastructure; an eighth, `Database`; plus
  `PlaybackGrant` and shared types).
  Check: `cd milk-crate && npm run api:core`.
- Generated client: `milk-crate/src/lib/api/`. Regenerate: `cd milk-crate && npm run api:client`.

## Order
B first. C and D can start with B. E, F and G start when B's pull request is merged. G's
cross-cloud check runs last, after E and F.

| Session | Owns |
|---|---|
| B | Database |
| C | Read rules and the account-type claim |
| D | CI |
| E | Supabase deployment |
| F | AWS deployment |
| G | Shared core handlers and the cross-cloud check |

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
  store or return the code itself. Session G checks all three in one transaction.
- The staff table `(user_id, account_type)` for `internal`, `internal_accounting` and
  `third_party`, with the staff and `artist` exclusion enforced in the database. Every
  `public.admins` row means `administrator`. Session C writes the claim hook and read rules.
- Play events: a batch with the same idempotency key counts once. The server decides what
  is a qualified stream (30 seconds or more). The client never sends counts.
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
- Source of the claim (settled): every `public.admins` row maps to `administrator`. A new
  staff table `(user_id, account_type)` holds `internal`, `internal_accounting` and
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
- Don't create real resources or use real keys. Provide the code, infrastructure definition
  and a script K Marcus runs. Tests use mocks or local emulators.
- Lambda entry points call G's handlers and only do wiring.

Done when: the interface tests pass against mocks or emulators, and the stand-up script is
ready for K Marcus to run.

## G: Shared core handlers and the cross-cloud check
Branch `phase0/g-core`.
- One handler per operation in `core/`, using `Request`, `Response` and the modules from
  `Modules`. Reach the database only through `Database`, with parameters and a
  transaction wherever more than one write must go together. Errors use the one `Error` shape. Enforce the account types and state moves in
  the contract.
- Unit tests with fake modules. The same handler code runs on Deno and Node.
- After E and F: a test suite that runs the same scenario against both deployments (create a
  release, upload a master, add splits, submit, review, publish, play, take down) and checks
  they behave the same.

Done when: every operation has a handler and tests, the suite passes with fake modules, and
the cross-cloud scenario runs against both deployments' code.

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

- **Resending an invitation.** A new endpoint, `resendInvitation`: release owner only, party
  must be `invited`, issues a new 14-day code and voids the old one, limited per party per day.

## Open before work starts
None.

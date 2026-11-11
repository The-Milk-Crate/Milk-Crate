You are session G of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A and B are merged. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and your section, "G: Shared core handlers and the cross-cloud check")
2. `api/openapi.yaml` (the contract, 21 operations; each lists `x-account-types` and `x-state-moves`, and the top of the file has the table of release state moves)
3. `api/README.md` (who may call what)
4. `core/src/platform/` (the eight interfaces and `Modules`; read `types.ts`, `database.ts`, `storage.ts` and `playback.ts` closely)
5. `db/` (session B's tables, SQL functions, tests and README; your handlers call these)

Your job is in two stages. Do stage 1 now, then stop.

### Stage 1: the shared handlers
One handler per operation, in `core/`. Handlers use web-standard `Request` and `Response`, take their modules (`Modules`: database, identity, storage, jobs, schedules, secrets and email) as an argument, and run unchanged on Edge Functions (Deno) and Lambda (Node 22). No platform SDK imports, and no runtime dependencies in `core/`.

Build:
- Handlers for all 21 operations in the contract: `createRelease`, `getRelease`, `getPublicRelease`, `startUpload`, `getUpload`, `signUploadParts`, `confirmUpload`, `updateRelease`, `listReleases`, `startCoverUpload`, `getCover`, `putRights`, `getInvitation`, `respondToSplit`, `resendInvitation`, `submitRelease`, `reviewRelease`, `publishRelease`, `takedownRelease`, `getPlayback`, `recordPlays`.
- Request checks written from the contract (hand-written small validators; the library route is closed because `core/` has no runtime dependencies). Responses and errors use the contract's shapes, and every error uses the one `Error` shape with a stable `code`, plain-words `message` and a `requestId`.
- The account-type rules: each operation allows only the account types in its `x-account-types`, plus the owner checks the contract describes. A hidden release looks like a missing one (404) to listeners.
- Read access (settled): your handlers enforce it on both deployments, passing the caller into every query. Aurora has one shared login and no per-caller rules, so the handlers are the only check there. Session C (working in parallel) writes an expected-results fixture in `db/test/`; if it is merged before you finish, test against it; if not, list it as an open point.
- State moves: only the server moves a release. Do every move through session B's SQL functions, inside one `Database` transaction wherever more than one write must go together. Follow the contract: approve records the decision and does not change the state; publish needs approval first (409 otherwise) and picks `scheduled` or `live` by the release date, and a scheduled release goes `live` through `Schedules` and B's SQL function.
- Release details: `updateRelease` allows only `draft`, `uploading`, `awaiting_splits` and `needs_changes` (409 otherwise) and never changes the state; `startUpload` allows only `draft`, `uploading`, `needs_changes` and `failed` (409 otherwise), and from `failed` moves to `uploading` and clears the failure reason; a `tracks` list that misses, repeats or invents a track is 422. `listReleases` is scoped by account type (an artist sees only their own; `administrator` and `internal` see all), newest first, with the `state` filter and cursor paging; summaries only.
- Cover art: `startCoverUpload` returns the same `UploadSession` with `kind` set to `cover` (JPEG or PNG, up to 20 MiB, stored at `art/{artist}/{release}/cover/original`, never altered). `confirmUpload` for a cover also reads the first bytes with `ObjectStorage.readHead` and gets the width and height from the PNG or JPEG header with a small hand-written reader (no image library in `core/`), and returns 422 if the image is unreadable or not square; it queues no processing and changes no state. `getCover` follows the same rules as playback: owners, `administrator` and `internal` in any state, everyone else only when `live`, 404 when there is no cover.
- Uploads: `startUpload` calls `ObjectStorage` and returns the `UploadSession` as the contract's tagged union by `method`. Store keys, never public URLs. Masters are never altered. `confirmUpload` checks what storage reports (size, and CRC64NVME on S3) and records the client's SHA-256; the worker checks the SHA-256 later (settled).
- Split invitations: make a random single-use code, store only its hash (use the Web Crypto `crypto.subtle`, which exists on both Deno and Node 22), send it by email through `SecretsAndEmail`, and never return it from any endpoint. Session B's functions do the checking (see "From session B" below): `getInvitation` calls `api_get_invitation`, which checks the hash and expiry without using up the code and returns only the contract's `Invitation`; `respondToSplit` calls `api_respond_to_invite` with the signed-in account, which checks hash, expiry and used-at in one go and links the account; `resendInvitation` calls `api_issue_invite` with your daily send limit. B counts wrong codes per party for both and locks a party after 10 in an hour; map its statuses to HTTP codes.
- Plays: `recordPlays` takes a batch with the `Idempotency-Key` header; the same key twice counts once and returns `duplicate: true`. The server decides what is a qualified stream (30 seconds or more) through session B's SQL; the client never sends counts.
- Playback: `getPlayback` checks entitlement and asks `ObjectStorage.signRead` for the grant on the track's streaming copy key (session B's track column, under `streams/{artist}/{release}/{track}/`; never a master); the core adds the track id. 404 when the track has no streaming copy yet (session H fills it later; test with a fake key). Owners and reviewers may get a grant for a release that is not live; everyone else gets 404.
- Takedown: administrator only. Remove listener access, delete the release's `masters/`, `streams/` and `art/` prefixes through `ObjectStorage.delete`, write the audit row listing what was removed, and email the owner (the email is in `api_accounts`). `review_needs_changes` uses the same email.
- The worker's result: no HTTP operation exists for it. Write a plain function in `core/` that applies a job result by job id (session B's jobs table gives the release; success moves `processing` to `awaiting_splits`; failure moves it to `failed` with the plain-words reason). Each deployment's `Jobs.reportResult` calls it. State its name next to the handler path.
- A small router that maps method and path to a handler, so each deployment's entry point stays thin. Choose where the handlers live (suggested: `core/src/handlers/`), state the path at the top of your pull request, and export everything a deployment needs from one place. Sessions E and F are waiting on this path.
- Tests with fake modules (an in-memory fake of `Database` is not enough for transactions and SQL functions: use session B's throwaway local PostgreSQL 16 approach in `db/test/` for the paths that run SQL, and fakes for storage, jobs, schedules, email and identity). Cover: every operation's allowed and refused account types, every state move and every refused move (409), the 100-percent rule, invite code single use and expiry, idempotent play batches, hidden releases, and takedown.
- Keep a clock and a random source as injected arguments so tests are repeatable.

### From session B (merged; use these, don't rebuild them)
Read `db/README.md`. B's functions lock the release row and enforce the rules, so your handlers mostly call them and map the result.
- **Errors.** B raises SQLSTATE `MC403`, `MC404`, `MC409` and `MC422`, with a code word at the start of the message (for example `wrong_state:`). Map them to 403, 404, 409 and 422, and put the code word in the `Error` `code`. A plain constraint error (`23xxx`) means a handler sent something it should have caught as 400 or 422.
- **Invitation statuses.**
  - `ok` → 200.
  - `wrong_code` and `expired` → 403.
  - `replied` and `taken_down` → 409.
  - `rate_limited` → 429.
  - `not_found` → 404.
  - For `api_issue_invite`, `not_invited` → 409.

  The invite functions record wrong codes, so commit even when they return `wrong_code`. `api_invite_wrong_count` is there only if you want a stricter limit than B's 10 an hour.
- **Rights (`putRights`).**
  - The owner's own share is a party with `is_owner = true`. It is accepted at once and gets no invitation.
  - New parties start `invited`. Send each one an invitation with `api_issue_invite`.
  - A non-owner party whose details change goes back to `invited` with its code voided, so send it a new invitation.
  - Keep party ids for parties the request sends back.
- **Suspended accounts.** `api_accounts.suspended` means the account may not act. B already refuses a suspended owner creating a release, and a suspended reviewer or administrator, and lists nothing for them. Refuse a suspended account on the other artist and staff endpoints too (403).
- **Functions per operation.**
  - `listReleases`: `api_list_releases(caller, state, limit + 1, after_created_at, after_id)`. Build the cursor from the last row's `created_at` and `id`, kept exactly as returned.
  - `startUpload` and `startCoverUpload`: `api_upload_key`, then storage, then `api_start_upload`.
  - `confirmUpload`: `api_confirm_upload`. Queue the job when `start_processing` is true.
  - `reviewRelease`: `api_record_review`.
  - `publishRelease`: `api_publish_release`. When it returns `scheduled`, call `Schedules.runSqlFunctionAt` with `fn: "api_release_go_live"` and `args: { p_release_id }` on the release date.
  - `takedownRelease`: `api_takedown_release`, delete the returned prefixes, then `api_takedown_files_deleted`.
  - `recordPlays`: `api_record_play_batch`, where `duplicate` → 202 with `duplicate: true` and `conflict` → 409.
  - The job result: `api_apply_job_result`, which is safe to call twice.
- **Calling through `Database`.**
  - Cast parameters in the SQL (`$1::uuid`, `$2::jsonb`).
  - Pass lists as JSON text.
  - Read `numeric`, `bigint`, `date`, `timestamptz` and `jsonb` results as strings or parsed values, the same on both deployments.

### Constraints
- `core/` gets no runtime dependencies. A test runner or `@types/node` may be added as a dev dependency only. Propose your choice in the pull request as an open point; keep it minimal. Check the handlers also run on Deno if Deno is available here, and say so if you can't.
- Don't change the contract, the interfaces, session B's database, or the app's existing tables, policies, screens or Supabase calls. If a handler needs one of those changed, write the change and the reason as an open point.
- Don't write deployment code (sessions E and F), read rules or the claim hook (session C), or CI (session D).
- SQL goes through `Database` with parameters (`$1`, `$2`). Never build SQL by joining values into text.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/g-core`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Stage 1 is done when
- Every operation has a handler and tests, and the tests pass.
- `core/` and `milk-crate/` type-check and `cd milk-crate && npm test` still passes.
- The handler path is stated at the top of the pull request.
- The pull request description lists: what you built, what you ran and its result, the open points for K Marcus (at least: the test runner choice, any change a handler needs in another session's work, where rate limits (429) for play batches and resends are enforced, the minimum cover size in pixels, and the numbers: wrong codes allowed before 429 and over what window, and sends per party per day), and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

### Stage 2 (do not start it now)
After sessions E and F are merged, K Marcus will send you a second prompt (`docs/phase0-prompts/g2-cross-cloud.md`): a test suite that runs the same scenario (create a release, upload a master, add splits and accept them, submit, review, publish, play, take down) against both deployments' module sets and checks they behave the same. It will use the mocks and local Postgres those sessions built, plus a script K Marcus can later point at real deployments through environment variables, with no secrets in the repository.

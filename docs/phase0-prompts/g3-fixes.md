You are session G3 of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to H are merged, and so is G stage 2, the cross-cloud check (The-Milk-Crate/Milk-Crate#36). G2 ran one scenario on both deployments' module sets and found three problems and one weak spot. K Marcus decided how to fix each. Your job is those fixes, before session I's security review, so I reviews the final code. The fixes cross the usual owners (G's handlers, B's database, the contract, F's AWS modules). K Marcus routed them all to one session, as with the E and F wiring (The-Milk-Crate/Milk-Crate#32).

Read these first, in this order:
1. `docs/phase0-handoff.md` (where things stand; step 6 lists K Marcus's decisions on G2)
2. The description of The-Milk-Crate/Milk-Crate#36 (the findings, with the steps and what each deployment answered)
3. `docs/phase0-sessions.md` (shared rules, and the sections for B, C, D, E, F and G)
4. `tests/cross-cloud/README.md` and `tests/cross-cloud/lib/findings.ts` (how the check works, and the entries your fixes change)
5. `api/openapi.yaml`, `core/src/handlers/` (`releases.ts`, `uploads.ts`, `views.ts`, `rights.ts`), `db/migrations/` and `db/test/`, `deploy/aws/src/modules.ts`

### Fix 1: a master stored after a takedown, on Supabase (G2 finding 1)

**The problem.** An upload is open when an administrator takes the release down, and the artist's app sends the rest afterwards.
- On AWS, takedown aborts the open multipart uploads, so nothing is stored.
- On Supabase, `delete` removes only stored objects, and an open TUS upload is not one yet. Its signed upload token (about 2 hours) still works, so the upload completes and a master is stored for the taken-down release.

**Decided by K Marcus:**
- The hourly sweep (`makeRetryTakedownDeletes` in `core/src/handlers/releases.ts`) deletes a taken-down release's `masters/`, `streams/` and `art/` prefixes once more, at least 2 hours after the takedown, when the upload tokens have expired.
- No change to the `ObjectStorage` interface.

**How to mark it done.** Today the takedown handler marks the audit row done (`api_takedown_files_deleted`, setting `files_deleted_at`) as soon as its first delete works, and the sweep only picks up rows where that is still empty. Choose how the sweep knows a takedown still needs its late pass, and say how in your pull request. Two options:
- mark the row done only after a delete that ran 2 hours or more after the takedown;
- or add a second column with a migration.

A takedown older than the window whose files are already gone needs nothing.

**Part of the same fix: `getUpload` on a closed upload.**
- **The problem.** On Supabase, `getUpload` signs a fresh upload token, valid about 2 hours, each time it is called (`supabaseStorage.getUpload` calls `signUpload`). The handler does not check the upload's state, so after a takedown the app can call `getUpload` on the cancelled upload, get a new token and finish the file at any time. The 2-hour window then does not hold.
- **Decided by K Marcus:** `getUpload` answers 409 `upload_closed` for an upload that is not `open`, before it calls storage. That is the same answer `signUploadParts` and `confirmUpload` already give.
- **The contract** gets a 409 response on `getUpload`, in the same change as fix 3.
- **C's fixture.** `db/test/access-expected.json` expects the owner's `getUpload` to answer 200 in every release state, including `taken_down`, where takedown has cancelled the uploads. The same cell drives session C's row level security checks in `db/test/supabase-checks.sql`, which read the `api_uploads` row directly. A cancelled upload is still the owner's to read there.
  - Ask K Marcus how the fixture should say "the owner may read it, but the API answers 409 because it is closed" before you change that file or C's checks.
  - The tests that seed confirmed uploads (`core/test/helpers.ts`, `tests/cross-cloud/lib/seed.ts`) will need open uploads, or the expected answer changes. Settle that in the same question.

### Fix 2: a malformed path id answers 400, which the contract does not list (G2 finding 3)

**The problem.** `pathUuid` answers 400 `bad_request` for a path id that is not a uuid, on both deployments.

**Decided by K Marcus.** The contract adds the 400 response to `getRelease`, `getPublicRelease`, `getCover`, `getUpload`, `submitRelease`, `publishRelease`, `resendInvitation` and `getPlayback`. This is a contract change K Marcus approved; it is the only one allowed in this session, together with fix 1's 409 on `getUpload`. Then:
- run `cd milk-crate && npm run api:client` and commit `milk-crate/src/lib/api/schema.d.ts`, so `client-fresh` passes;
- run `npm run api:lint`;
- remove the entry in `CONTRACT_GAPS` in `tests/cross-cloud/lib/findings.ts` (the cross-cloud suite then checks those answers against the contract).

### Fix 3: the order of rights parties (G2 finding 2)

**The problem.** `putRights` writes every party in one transaction, so they share `created_at`. `getRelease` orders them by `created_at, id`, which is the order of random ids: the order changes from release to release and does not follow what the artist sent. `putRights`'s own answer keeps the order sent.

**Decided by K Marcus:**
- A new migration (`db/migrations/0008_...`) adds a `position` column to `api_parties`.
- `putRights` writes each party's place in the request.
- `getRelease` (`core/src/handlers/views.ts`) orders by it.

**Constraints:**
- Follow session B's rules for migrations: safe to run twice, applied whole by psql and split into single statements by F's Data API path (`deploy/aws/test/run.sh` checks both give the same schema).
- The Supabase stand-up applies it too, and C's lock-down must still hold (`bash db/test/run.sh`).
- Existing rows need a position. Choose a fill (for example by `created_at, id`) and say which.

**In the cross-cloud suite.** The two facts named "party states" sort their values (`tests/cross-cloud/lib/scenario.ts`). Make them check the order exactly, and remove the shared finding in `lib/findings.ts`.

### Fix 4: the cross-cloud suite copies `createAwsModules` by hand (G2 weak spot)

**The problem.** `createAwsModules` (`deploy/aws/src/modules.ts`) creates its own AWS SDK clients, so tests cannot hand it fakes, and `tests/cross-cloud/lib/mocks.ts` repeats its wiring line by line. A later change to `createAwsModules` would go untested.

**Decided by K Marcus.** `createAwsModules` gets one optional argument for the clients and helpers it makes, with the real ones as the default:
- the RDS Data API, S3, Scheduler, Secrets Manager and SES clients;
- the presigner;
- the CloudFront cookie signer;
- the identity key lookup, so tests can use a local JWKS.

Nothing changes in deployment.

**Then:**
- `tests/cross-cloud/lib/mocks.ts` builds the AWS side with `createAwsModules` itself, as the Supabase side already uses `createSupabaseModules`;
- remove the hand-wired copy;
- keep `bash deploy/aws/test/run.sh` passing; F's stack test checks the Lambda entry points.

### When a fix lands, the cross-cloud suite changes with it
- `tests/cross-cloud/lib/findings.ts`. Fix 1 removes the `KNOWN_DIFFERENCES` entry. A test there fails until it is removed, on purpose. Fix 2 removes `CONTRACT_GAPS`. Fix 3 removes `SHARED_FINDINGS`.
- After fix 1, both sides should refuse the rest of the open upload, or at least store nothing once the sweep's late pass has run. Add a step that runs the sweep's late pass on each mock deployment (move the takedown's time back, as the core tests do) and checks no master is left.
- `bash tests/cross-cloud/run.sh` must pass with no known differences left. If a fix shows a new difference, report it; don't hide it.

### From session D (CI)
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers`, `worker-processing` and `cross-cloud` (decided by K Marcus with G2; check the ruleset has it).
- Run them yourself before you push:
  - from the repository root: `bash db/test/run.sh`, `bash core/test/run.sh`, `bash deploy/supabase/test/run.sh`, `bash deploy/aws/test/run.sh`, `bash worker/test/run.sh` and `bash tests/cross-cloud/run.sh`;
  - from `milk-crate/`: `npm ci`, `npm run api:lint`, `npm run api:client` (then commit `src/lib/api/schema.d.ts`), `npm run api:core`, `npx tsc --noEmit` and `npm test`.
- No new CI job is needed: your changes fall under the existing jobs' paths. Don't change `.github/workflows/`.

### Constraints
- Only these fixes. No other change to the contract, the interfaces, the deployments or the database.
- Don't change the app's existing tables, policies, screens or Supabase calls.
- No real projects, accounts, keys or network calls. Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/g-fixes`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/`. Never edit `build.yml` or `pages.yml`: `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract changes only as fixes 1 and 2 say. Any other change is an open point for K Marcus in the pull request.
- Ask before deciding anything this brief doesn't cover (the fixture question in fix 1 is one). List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- The four fixes are in, each with tests, and every required check passes locally.
- `bash tests/cross-cloud/run.sh` passes with `KNOWN_DIFFERENCES`, `CONTRACT_GAPS` and `SHARED_FINDINGS` empty, and the party order checked exactly.
- The AWS side of the cross-cloud suite is built by `createAwsModules`.
- The pull request description lists:
  - what you changed, per fix;
  - what you ran and its result;
  - how fix 1 marks a takedown done;
  - the position fill for existing rows;
  - the fixture question and K Marcus's answer;
  - open points and assumptions.

Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

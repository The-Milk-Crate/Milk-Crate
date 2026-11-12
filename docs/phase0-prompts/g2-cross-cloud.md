You are session G of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. This is stage 2 of your job: the cross-cloud check. Stage 1 (the shared handlers in `core/`) is merged, and so are sessions B (database), C (read rules and the account-type claim), E (Supabase deployment) and F (AWS deployment).

The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other. Your check is the proof of that.

Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and "G: Shared core handlers and the cross-cloud check")
2. `api/openapi.yaml` (the contract, 21 operations; the table of release state moves is at the top)
3. Your own stage 1 handlers and tests in `core/`, and the handler path stated in that pull request
4. `deploy/supabase/` and `deploy/aws/` (sessions E and F: their modules, adapters, tests and the open points in their pull requests)
5. `db/` (session B's test approach, and session C's fixture `db/test/access-expected.json` and claim definition `db/account-claim.json`)

Your job: a test suite that runs the same scenario against both deployments' module sets and checks they behave the same, plus a script K Marcus can later point at real deployments.

### Build
- One scenario, run twice, once with Supabase's modules (session E) and once with AWS's modules (session F), through the shared router and handlers. It follows the whole slice:
  1. An artist creates a draft release with two tracks.
  2. Starts an upload for each master, interrupts one, resumes it from where it stopped, confirms both (with the checksums the contract asks for).
  3. The processing result arrives (success), and the release moves to `awaiting_splits`.
  3b. The artist edits the title and track order, and a track list that misses a track is refused (422); uploads a square cover (a non-square one is refused with 422); lists their releases (they see only their own).
  4. The artist adds rights and splits for recording and composition; each invitee first views the invitation with their code (they see only the release basics and their own share, never other parties, emails or `owner_id`), then accepts; a wrong code is refused (403) on both the view and the reply, too many wrong codes (counted across both) give 429, a used code gives 409 on the view, and a staff account is refused (403).
  4b. A second release fails processing (`failed`, with a reason), the artist replaces the master, and it goes `failed` → `uploading` → `processing`.
  5. Submit, then a reviewer asks for changes with a reason, the artist fixes and resubmits, a reviewer approves.
  6. Publish with a future release date (`scheduled`), then the schedule fires and the release goes `live`.
  7. A reviewer lists releases with `state=awaiting_review` and sees it; an artist cannot see another artist's (404 on `getRelease`, left out of `listReleases`). A listener reads the public view (no `owner_id`) and gets playback for a track and reads the cover; a listener cannot see a release that is not live.
  8. Play events: `start`, `progress` and `end` in batches, the same batch sent twice counts once, and a play of 30 seconds or more counts as a qualified stream while a shorter one does not.
  9. An administrator takes the release down: access and files are removed and an audit row exists; a non-administrator reviewer is refused.
- Refused cases, in the same run: each account type calling an operation it is not allowed (403), a wrong release state (409), a bad request (400 or 422), no token (401), a suspended account (reads as `end_user`), and a staff account whose `api_accounts` row was removed while its token is still valid (treated as `end_user` at once; settled with session C).
- Session C's fixture: run every cell of `db/test/access-expected.json` on both module sets. Each side must match the fixture, not only each other.
- What "behave the same" means. For every step compare: the HTTP status, the error `code` when there is one, the release `state` after the step, and the response field names and types. Ignore ids, timestamps, URLs, signatures, cookies and codes. The only allowed differences are inside the contract's tagged unions: `tus` versus `s3_multipart` for uploads (masters and covers), and `signed_url` versus `cloudfront_cookies` for playback and cover reads. For those, check each deployment returns a valid branch and that the rest of the step matches.
- Use the mocks and local PostgreSQL that sessions B, E and F built (a throwaway local PostgreSQL 16, no Docker). Put the suite in a new folder, `tests/cross-cloud/`, with its own `package.json`. It may use dev dependencies (for example a YAML reader so the suite can read the contract), and nothing here goes into `core/` as a runtime dependency.
- A table-driven check from the contract: for each operation, its `x-account-types` and `x-state-moves` are exercised at least once on both sides, so a new operation without a test is a visible gap.
- A script for real deployments, `tests/cross-cloud/run-live.*`, that runs the same scenario against a base address and tokens read from environment variables (one base address and one token for each account type). It never contains or prints a secret, refuses to run when a variable is missing, and does nothing destructive outside the releases it creates. You write it and test it only against the mocks; you do not run it against anything real.
- One documented command from a clean checkout runs the suite and leaves no cluster or temp files behind. Keep it free of anything specific to one machine, because session D will run it in CI.

### From session E (merged; what its side gives you)
- **Mocks.** Session E's tests have the pieces for the Supabase module set:
  - `deploy/supabase/test/fake-storage.ts`: an in-memory Supabase Storage at its HTTP edge, with `tusSend`, a TUS client that sends part of a file then resumes;
  - `deploy/supabase/test/cron-standin.sql`: a pg_cron stand-in. Fire a schedule by running its `cron.job` command;
  - `deploy/supabase/test/run.sh`: how the stand-up SQL is applied on a throwaway cluster (`scripts/apply-sql.sh`).

  Reuse them; don't copy them.
- **Signed links.** Supabase's `signed_url` and AWS's `cloudfront_cookies` are both short-lived and made per request, and neither is bound to one listener. The contract says so (settled); don't report it as a difference.
- **File size.** The free Supabase project for Phase 0 caps files at 50 MiB (settled; `MC_FILE_SIZE_LIMIT=50MiB`). The live script must use masters of 50 MiB or less on both sides, so the cap is not reported as a difference. A free project also pauses after about a week without use: the live script should say so plainly when the project does not answer.
- **Jobs.** E reports a stuck job (past 4 hours) or a crash as a plain-words failure, and the skeleton before session H fails every release plainly. Session H's shared worker replaces that. If H is not merged, use a fake processing step on both sides.

### When the two sides differ
Don't fix sessions B, E or F's code, and don't change the handlers to hide a difference. Report each difference as a finding in the pull request: the step, what each deployment returned, which side looks wrong and why. K Marcus routes the fixes. If a difference is caused by the contract, say that instead.

### From session D (merged; CI)
- Every pull request into `milk-crate-backend-poc` runs "Phase 0 checks" (`.github/workflows/phase0-checks.yml`). Six checks must pass before it can merge: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests` and `database`.
- Run them yourself before you push. From the repository root: `bash db/test/run.sh`. From `milk-crate/`: `npm ci`, `npm run api:lint`, `npm run api:client` (then `git diff --exit-code src/lib/api/schema.d.ts` must be empty), `npm run api:core`, `npx tsc --noEmit` and `npm test`.
- `client-fresh` fails if `milk-crate/src/lib/api/schema.d.ts` no longer matches `api/openapi.yaml`. The contract is fixed, so this matters only if K Marcus approves a contract change: then run `npm run api:client` and commit the result.
- `database` runs when `db/**`, `milk-crate/supabase/**`, `api/openapi.yaml`, `core/src/platform/types.ts` or the workflow changes. If your change makes it fail, fix it on your branch.
- The checks start only for changes under `api/`, `core/`, `db/` and `milk-crate/`. A change only under `tests/cross-cloud/` skips them (a skipped check counts as passed), and nothing runs your suite in CI until its job is added.
- Don't edit `.github/workflows/`. Give your tests one documented command that runs from a clean checkout, with no keys and no network beyond package installs. In your pull request, list the CI job you want added: the command, the paths that should start it, and anything it must install. A session D follow-up adds it.

### Constraints
- Don't change the contract, the interfaces, the database, the deployments, or the app's existing tables, policies, screens or Supabase calls.
- Don't write CI (session D) or read rules (session C).
- No real projects, accounts, keys or network calls. Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/g-cross-cloud`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- The scenario and the refused cases pass on both module sets, or every difference is listed as a finding.
- Every operation's account types and state moves are exercised on both sides, and the table-driven check proves it.
- The live script exists, is tested against the mocks, and needs only environment variables.
- The suite runs with one documented command from a clean checkout and cleans up after itself; `core/` and `milk-crate/` still type-check and `cd milk-crate && npm test` still passes.
- The pull request description lists: what you built, what you ran and its result, every finding (differences between deployments), the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

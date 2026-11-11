You are session E of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Session A and B are merged. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and your section, "E: Supabase deployment")
2. `api/openapi.yaml` (the contract, 16 operations; the table of release state moves is at the top)
3. `core/src/platform/` (the eight interfaces; you implement all of them for Supabase)
4. `db/` (session B's migrations, tests and README)
5. `milk-crate/supabase/*.sql` and `milk-crate/src/lib/supabase.ts` (how the app uses Supabase today; do not change any of it)

Your job: the Supabase deployment. Implement each platform interface on Supabase, and the entry point wiring for Edge Functions. Session F does the same for AWS, and session G writes the shared handlers. Don't write handlers.

### Build (each one a module that implements its interface in `core/src/platform/`)
- Identity: who is calling, from the Supabase token. Read the `account_type` claim (session C writes the hook; you only read the claim). Return null for no valid token.
- Object storage:
  - Upload session method `tus`: resumable uploads through Supabase Storage. An interrupted upload resumes from the stored offset. Masters are WAV, AIFF or FLAC, up to 5 GiB, stored at `masters/{artist}/{release}/{track}/original` and never altered. Store keys, never public URLs.
  - Confirm: the client sends a SHA-256 of the file. Supabase Storage does not keep a SHA-256 of a stored object, and an Edge Function cannot read and hash 5 GiB within its time and memory limits. Do not pretend it can. Say plainly in the pull request how you check the SHA-256 (for example, the worker streams the object and hashes it, and confirm also checks the stored size) and what it costs for 5 GiB. List it as an open point.
  - Sign a read: playback method `signed_url`, a link made for that listener, short-lived, per request. If Supabase cannot bind a link to one listener, say so plainly in the pull request as an open point; don't pretend.
  - Delete everything under a prefix (used by takedown).
  - Storage limits: the app's README says the free plan caps a file at 50 MB. Record the file size limit and plan that 5 GiB needs in the stand-up script and the pull request.
- Jobs: queue a job and report its result. The worker runs on Fly Machines. Build the queue, the worker skeleton (picks up a `process_release` job, reports success or a plain-words failure) and the result path. What processing actually does to a master is not decided; don't invent it. List it as an open point.
- Schedules: run a SQL function at a time, using pg_cron (one-time runs; remove the job after it runs; setting the same name again replaces it).
- Server functions: a generic Edge Function adapter on Deno that turns a web-standard `Request` into a call of a shared handler with the modules, and returns its `Response`. Keep it small. The one-entry-point-per-operation files wait until session G's handlers exist; don't guess their path. List it as an open point.
- Secrets and email: get a secret by name (Edge Function secrets) and send the templates named in `secrets-email.ts`. Choose the simplest email path that works without a paid add-on; if none does, say so.
- Database: a pooled Postgres connection with transactions, with parameters (`$1`, `$2`). Never build SQL by joining values into text.
- Infrastructure: stand up, confirm, tear down, as a script and config K Marcus runs (`supabase/config.toml`, migration push, function deploy, storage buckets and limits, the Fly app config). You write them; you do not run them against anything real.

### Constraints
- No real projects, no real keys. You have no Supabase or Fly account access. Code, config and a script are the deliverable, and tests use mocks or a local Postgres.
- This environment has PostgreSQL 16 (no Docker daemon, no Supabase CLI). Reuse session B's throwaway Postgres approach in `db/test/` for the database module. Mock Supabase Storage, Fly and email at their HTTP edges, and check each with a test. Say what you could not run.
- Put your code under a new top-level folder, `deploy/supabase/`. Do not put SDK imports in `core/`; all Supabase code lives in your folder and may use Supabase packages there.
- Upload session shape and playback shape are the contract's: `tus` and `signed_url`. Don't change them.
- Don't change the app's existing tables, policies, screens or Supabase calls. Add alongside them. The app keeps calling Supabase directly for everything outside this slice until Phase 1.
- Don't write handlers (session G), read rules or the claim hook (session C), CI (session D), or AWS code (session F).

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/e-supabase`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret. Where a real credential is needed, write what is needed and stop.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- Every interface has a Supabase implementation with tests that pass against mocks or a local Postgres (`core/` and `milk-crate/` type-check, and `cd milk-crate && npm test` still passes).
- The stand-up script, config and tear-down are ready for K Marcus to run, and nothing in them needs a secret in the repository.
- The pull request description lists: what you built, what you ran and its result, what you could not run here, the open points for K Marcus (at least: the SHA-256 check and its cost, processing work, entry points waiting on session G, whether a link can be bound to one listener, the 5 GiB storage limit and plan), and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

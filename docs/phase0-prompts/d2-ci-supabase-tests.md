You are the session D follow-up of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to E are merged. Session D built "Phase 0 checks" (`.github/workflows/phase0-checks.yml`). Session E added the Supabase deployment and its tests in `deploy/supabase/`, but nothing runs those tests in CI yet: the workflow's `changes` job does not look at `deploy/`, so a pull request that only touches `deploy/supabase/` skips every heavy job. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules, "D: CI" and "E: Supabase deployment")
2. `.github/workflows/phase0-checks.yml` (yours to edit), then `build.yml` and `pages.yml` (read only; you must not edit them)
3. `deploy/supabase/README.md`, `deploy/supabase/test/run.sh` and `deploy/supabase/package.json`
4. Open point 12 in session E's pull request, The-Milk-Crate/Milk-Crate#19 (merged), which asked for this job

Your job: add one job to "Phase 0 checks" that runs session E's tests on pull requests. You are the only session that may edit files under `.github/workflows/`.

### Build
- One new job, `supabase-deploy`, in `.github/workflows/phase0-checks.yml`. It runs session E's one documented command from the repository root: `bash deploy/supabase/test/run.sh`.
  - The script installs `deploy/supabase/`'s packages itself (`npm ci`, if `node_modules` is missing), type-checks, starts its own throwaway PostgreSQL 16 cluster, applies the stand-up SQL, runs 68 tests, and removes the cluster, also when a test fails. So don't add a Postgres service container.
  - It needs Node 22.18 or newer, because it runs TypeScript directly with Node's type stripping. Use `actions/setup-node` with a version that resolves to 22.18 or newer, and print `node --version` in the job.
  - It needs PostgreSQL 16 server binaries, found the same way as `db/test/run.sh` (`/usr/lib/postgresql/16/bin`, then `pg_config --bindir`, then `PATH`; `PG_BIN` overrides). Do it the way the `database` job does: `runs-on: ubuntu-24.04`, and install `postgresql-16` with apt only if `initdb` is missing.
  - Cache npm on `deploy/supabase/package-lock.json`. Run `npm ci --no-audit --no-fund` in `deploy/supabase/` as its own step before the script, so an install failure is easy to see.
  - It needs no keys and no network beyond the package install. Supabase Storage, the Management API, Fly and Resend are mocked in the tests.
  - It runs as the normal runner user. Session E ran it as a non-root user, and it passed.
- Gate it on the `changes` job like the others. Add a third output, `supabase`, that is true when any of these change:
  - `deploy/supabase/**`
  - `db/**` (the stand-up applies `db/migrations/` and `db/supabase/`)
  - `milk-crate/supabase/**` (the stand-up loads the app's SQL on a fresh project)
  - `core/src/platform/**` (the modules implement these interfaces)
  - `.github/workflows/phase0-checks.yml`

  A manual run sets it true, like the other outputs. Leave the `app` and `db` patterns as they are: a `deploy/supabase/` change should start only the new job.
- Timeout: 15 minutes (the suite takes under a minute locally, plus the install).
- Keep everything else as it is: the other six jobs, pinned action SHAs, `permissions: contents: read`, `concurrency`, no secrets, no deploy jobs, no `pull_request_target`. Use the same pinned SHAs as the existing jobs for `checkout` and `setup-node`.
- Update the comment at the end of the workflow: E's job is now in; F's (AWS deployment tests) is still to come. Don't add a job for F; it isn't merged.
- In `docs/phase0-sessions.md`, under "D: CI" → "Merged. What D left for the others", add one line naming the new job and the paths that start it.

### Constraints
- Edit only `.github/workflows/phase0-checks.yml` and that one line in `docs/phase0-sessions.md`. Don't edit `build.yml` or `pages.yml`; `build.yml` publishes a desktop release on every push to `main`. Don't edit `deploy/`, `db/`, `api/`, `core/` or `milk-crate/`.
- If session E's script fails on the runner, don't fix it in `deploy/supabase/`. Describe the failure in the pull request for K Marcus.
- You can't run GitHub Actions in this environment. Run `bash deploy/supabase/test/run.sh` locally, from a clean checkout and as a non-root user if you can, and show the output in your pull request. Lint the workflow file if you can get a workflow linter (such as actionlint) without keys. Check the `changes` patterns by running the same `grep` against sample file lists, and show which outputs each list sets:
  - `deploy/supabase/src/storage.ts` alone: only `supabase`;
  - `db/migrations/0001_accounts.sql`: all three;
  - `docs/phase0-sessions.md` alone: none.
- Prove red as well as green, locally and without committing anything broken: make a throwaway change in `deploy/supabase/` (a type error, then a failing assertion), run the script, see it fail, and undo it.
- The pull request's own run is the real proof. It touches the workflow file, so every job runs, the new one included.
- You can't change repository settings or branch rules, so you can't make the new check required. Name it exactly (`supabase-deploy`) in the pull request so K Marcus can add it to the required checks for `milk-crate-backend-poc`.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/d-ci-supabase`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the workflow.
- Plain, short wording in comments and descriptions.

### Done when
- The workflow file is valid, and the new job's commands have been run locally with the result shown.
- The `changes` patterns were checked against the sample lists above, and the type error and failing test were each seen going red locally.
- `build.yml` and `pages.yml` are untouched (`git diff origin/milk-crate-backend-poc -- .github/workflows/build.yml .github/workflows/pages.yml` is empty), and the workflow still cannot run on a push to `main`.
- The pull request's own run shows `supabase-deploy` green, with the six existing checks still green.
- The pull request description lists: what you changed, the check name K Marcus should require, what you ran and its result, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

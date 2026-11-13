You are the second session D follow-up of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to F are merged, and so is the first D follow-up (`supabase-deploy`). Session F added the AWS deployment and its tests in `deploy/aws/`, but nothing runs those tests in CI yet: the workflow's `changes` job does not look at `deploy/aws/`, so a pull request that only touches `deploy/aws/` skips every heavy job. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules, "D: CI" and "F: AWS deployment")
2. `.github/workflows/phase0-checks.yml` (yours to edit), then `build.yml` and `pages.yml` (read only; you must not edit them)
3. `deploy/aws/README.md`, `deploy/aws/test/run.sh` and `deploy/aws/package.json`
4. Open point 7 in session F's pull request, The-Milk-Crate/Milk-Crate#23, which asked for this job

Your job: add one job to "Phase 0 checks" that runs session F's tests on pull requests. You are the only session that may edit files under `.github/workflows/`.

### Build
- One new job, `aws-deploy`, in `.github/workflows/phase0-checks.yml`. It runs session F's one documented command from the repository root: `bash deploy/aws/test/run.sh`.
  - The script installs `deploy/aws/`'s packages itself (`npm ci`, if `node_modules` is missing), type-checks, and starts its own throwaway PostgreSQL 16 cluster. It applies `db/migrations/` twice through the Data API path and twice whole with `psql`, and checks the two schemas match. Then it runs 102 tests (including an offline CDK synth) and removes the cluster, also when a test fails. So don't add a Postgres service container.
  - It needs Node 22.18 or newer, because it runs TypeScript directly with Node's type stripping. Use `actions/setup-node` with the same version range and pinned SHA as `supabase-deploy`, and print `node --version` with the same check.
  - It needs PostgreSQL 16 server binaries, found the same way as `db/test/run.sh` (`/usr/lib/postgresql/16/bin`, then `pg_config --bindir`, then `PATH`; `PG_BIN` overrides). Do it the way the `database` and `supabase-deploy` jobs do: `runs-on: ubuntu-24.04`, and install `postgresql-16` with apt only if `initdb` is missing.
  - Cache npm on `deploy/aws/package-lock.json`. Run `npm ci --no-audit --no-fund` in `deploy/aws/` as its own step before the script, so an install failure is easy to see.
  - It needs no keys, no AWS account, no Docker and no network beyond the package install. Every AWS service is mocked at its SDK edge. The Data API is a test stand-in over the local Postgres. The CDK stack is synthesized offline, with esbuild (a package dependency) bundling the Lambdas, not Docker.
  - It runs as the normal runner user. Session F ran it as a non-root user from a clean copy of the tree, and all 102 tests passed.
  - It writes only to the system temp directory and to `deploy/aws/node_modules`, and removes its temp directories when it ends.
- Gate it on the `changes` job like the others. Add a fourth output, `aws`, that is true when any of these change:
  - `deploy/aws/**`
  - `db/**` (the stand-up applies `db/migrations/`, and a test checks the split against every migration file; it also reads `db/account-claim.json`)
  - `core/src/platform/**` (the modules implement these interfaces)
  - `deploy/supabase/src/email-templates.ts` and `deploy/supabase/worker/run.ts` (two tests check that session F's email templates and worker skeleton still match session E's)
  - `.github/workflows/phase0-checks.yml`

  A manual run sets it true, like the other outputs. Leave the `app`, `db` and `supabase` patterns as they are: a `deploy/aws/` change should start only the new job.
- Timeout: 15 minutes (the suite takes about 15 seconds locally after the install, plus the install itself).
- Do not run `deploy/aws/scripts/smoke.sh` or any other script in `deploy/aws/scripts/`. They need a real stand-up and AWS credentials, and Phase 0 has no deploy jobs.
- Keep everything else as it is: the other seven jobs, pinned action SHAs, `permissions: contents: read`, `concurrency`, no secrets, no deploy jobs, no `pull_request_target`. Use the same pinned SHAs as the existing jobs for `checkout` and `setup-node`.
- Replace the comment at the end of the workflow ("Later: session F's AWS deployment tests ..."): F's job is now in. Keep the note that there are no secrets or deploy jobs in this phase.
- In `docs/phase0-sessions.md`, under "D: CI" → "Merged. What D left for the others", add one line naming the new job and the paths that start it.

### Constraints
- Edit only `.github/workflows/phase0-checks.yml` and that one line in `docs/phase0-sessions.md`. Don't edit `build.yml` or `pages.yml`; `build.yml` publishes a desktop release on every push to `main`. Don't edit `deploy/`, `db/`, `api/`, `core/` or `milk-crate/`.
- If session F's script fails on the runner, don't fix it in `deploy/aws/`. Describe the failure in the pull request for K Marcus.
- You can't run GitHub Actions in this environment. Run `bash deploy/aws/test/run.sh` locally, from a clean checkout and as a non-root user if you can, and show the output in your pull request. Lint the workflow file if you can get a workflow linter (such as actionlint) without keys. Check the `changes` patterns by running the same `grep` against sample file lists, and show which outputs each list sets:
  - `deploy/aws/src/storage.ts` alone: only `aws`;
  - `deploy/supabase/src/email-templates.ts` alone: `supabase` and `aws`;
  - `deploy/supabase/src/storage.ts` alone: only `supabase`;
  - `core/src/platform/storage.ts`: `app`, `supabase` and `aws`;
  - `db/migrations/0001_accounts.sql`: all four;
  - `docs/phase0-sessions.md` alone: none.
- Prove red as well as green, locally and without committing anything broken: make a throwaway change in `deploy/aws/` (a type error, then a failing assertion), run the script, see it fail, and undo it.
- The pull request's own run is the real proof. It touches the workflow file, so every job runs, the new one included.
- You can't change repository settings or branch rules, so you can't make the new check required. Name it exactly (`aws-deploy`) in the pull request so K Marcus can add it to the required checks for `milk-crate-backend-poc`.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/d-ci-aws`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the workflow.
- Plain, short wording in comments and descriptions.

### Done when
- The workflow file is valid, and the new job's commands have been run locally with the result shown.
- The `changes` patterns were checked against the sample lists above, and the type error and failing test were each seen going red locally.
- `build.yml` and `pages.yml` are untouched (`git diff origin/milk-crate-backend-poc -- .github/workflows/build.yml .github/workflows/pages.yml` is empty), and the workflow still cannot run on a push to `main`.
- The pull request's own run shows `aws-deploy` green, with the seven existing checks still green.
- The pull request description lists: what you changed, the check name K Marcus should require, what you ran and its result, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

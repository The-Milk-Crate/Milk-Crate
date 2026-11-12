You are session D of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A, B and C are merged. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and your section, "D: CI")
2. `.github/workflows/build.yml` and `.github/workflows/pages.yml` (read only; you must not edit them)
3. `api/README.md`, then the scripts in `milk-crate/package.json` (`api:lint`, `api:client`, `api:core`, `test`)
4. `core/package.json` and `db/` (session B's migrations, test and README, and session C's `db/supabase/` and its checks in `db/test/`)

Your job: continuous integration for pull requests. Today nothing checks a pull request: both existing workflows run only on pushes to `main`. You are the only session that may add files under `.github/workflows/`.

### Build
- One new workflow file, `.github/workflows/phase0-checks.yml`, that runs on pull requests into `milk-crate-backend-poc` and `main`, and on manual dispatch. It must never run on a push to `main` and must not publish, release or deploy anything.
- Jobs, each with a clear name (K Marcus will mark some as required checks):
  - `contract`: lint the contract (`npm run api:lint`, from `milk-crate/`).
  - `client-fresh`: regenerate the client (`npm run api:client`) and fail if `milk-crate/src/lib/api/schema.d.ts` differs from what is committed (`git diff --exit-code`).
  - `types`: type-check `core/` (`npm run api:core`) and `milk-crate/` (`npx tsc --noEmit`).
  - `desktop-tests`: `cd milk-crate && npm test`.
  - `database`: run session B's test exactly as `db/README.md` documents: `bash db/test/run.sh` from the repository root.
    - It starts its own throwaway PostgreSQL cluster, so don't add a Postgres service container.
    - It needs PostgreSQL 16 server binaries. It looks in `/usr/lib/postgresql/16/bin`, then `pg_config --bindir`, then `PATH`, and `PG_BIN` overrides that. Pin `runs-on: ubuntu-24.04`, whose image ships PostgreSQL 16; if the binaries are missing, install `postgresql-16` with apt in the job.
    - The script runs as the normal runner user. Session B checked it as a non-root user.
    - Session C's Supabase checks are already part of it (step 5 of the same script), so there is no separate job for C. They load the app's SQL from `milk-crate/supabase/` and compare the account types in `api/openapi.yaml`, `core/src/platform/types.ts`, `db/account-claim.json` and the fixture.
    - Run it when `db/**`, `milk-crate/supabase/**`, `api/openapi.yaml`, `core/src/platform/types.ts` or the workflow file changes.
    - If the script fails on the runner, do not edit `db/`. Describe the failure in the pull request for K Marcus.
- Use `npm ci` (not `npm install`) in each package, with the npm cache keyed on the lockfiles. Use Node 22.
- Pin every third-party action to a full commit SHA with the version in a comment. Use the minimum permissions (`contents: read`), set a timeout on every job, and cancel older runs of the same pull request (`concurrency`).
- Paths: run only when something relevant changed (`api/**`, `core/**`, `db/**`, `milk-crate/**`, and the workflow file itself). A docs-only change should not need the heavy jobs.
- Later sessions will add jobs for sessions C, E and F. Leave a short comment in the workflow saying where, but don't add jobs for things that don't exist yet.

### Constraints
- New files only under `.github/workflows/`. Don't edit `build.yml` or `pages.yml`. Nothing here may need a change to them; `build.yml` publishes a desktop release on every push to `main`.
- No secrets, tokens or environments in the workflow for this phase. No deploy jobs; those wait for K Marcus. Don't use `pull_request_target`.
- You can't run GitHub Actions in this environment. Check each step by running the same commands locally, and lint the workflow file if you can get a workflow linter (such as actionlint) without keys. Show the output in your pull request. The pull request's own run is the real proof.
- Prove red as well as green, locally and without committing anything broken: make a throwaway change (a bad contract line, a type error, a failing test, a stale `schema.d.ts`), run the matching command, see it fail, and undo it.
- You can't change repository settings or branch rules, so you can't make a check required. Name the exact check names in the pull request so K Marcus can set the rule.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/d-ci`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the workflow.
- Plain, short wording in comments and descriptions.

### Done when
- The workflow file is valid, and every step has been run locally with the result shown.
- Each failure case above (bad contract, type error, failing test, stale client) was seen going red locally, and a clean tree goes green.
- `build.yml` and `pages.yml` are untouched (`git diff origin/milk-crate-backend-poc -- .github/workflows/build.yml .github/workflows/pages.yml` is empty), and the workflow cannot run on a push to `main`.
- The pull request description lists: what you built, the check names K Marcus should require, what you ran and its result, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

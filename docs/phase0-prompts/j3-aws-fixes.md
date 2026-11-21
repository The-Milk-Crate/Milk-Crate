You are session J3 of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to I are merged. Session I's security review is in `docs/security/review-phase0.md`, and K Marcus decided a fix for every finding (the table "Decided by K Marcus" near the end). Four sessions make the fixes, by owner: J1 (database, handlers and both email template files), J2 (Supabase, `deploy/supabase/`), **J3 (you): session F's AWS deployment, `deploy/aws/`**, and J4 (the worker, `worker/`). They can run at the same time. Don't change files the others own; in particular, `deploy/aws/src/email-templates.ts` is J1's in this round.

Read these first, in this order:
1. `docs/security/review-phase0.md` (findings M2, M3, L4, L8, L9, and the decision table)
2. `docs/phase0-sessions.md` (shared rules, and F's section)
3. `docs/phase0-handoff.md` (the sandbox runs and working notes)
4. `deploy/aws/README.md`, `deploy/aws/src/storage.ts`, `deploy/aws/infra/stack.ts`, `deploy/aws/test/`, `tests/cross-cloud/lib/fake-s3.ts`

### Fix 1: upload parts (M3)

**Decided by K Marcus:**
- **Part size in the signed URL.** `sign` in `deploy/aws/src/storage.ts` presigns `UploadPartCommand` with no `ContentLength`, so a part URL takes up to 5 GiB. Set `ContentLength` to that part's planned size (`partBytes(plan, sizeBytes, n)`; the last part is smaller), so S3 refuses any other length. Check with a test that the signed URL lists `content-length` in its signed headers (`X-Amz-SignedHeaders`), and say in the pull request that the next sandbox run must confirm S3 refuses a wrong length (add that check to `scripts/smoke.ts` if it fits in a few lines; otherwise list it).
- **Abort replaced uploads.** When a new upload starts for a key, abort every other unfinished multipart upload for that same key first (`ListMultipartUploads` with the key as prefix, keep only exact key matches, `AbortMultipartUpload`), inside `startUpload`. This stays inside the storage module: no interface change, and nothing in `core/` or `db/`.
- **Lifecycle.** `UPLOAD_DAYS` from 7 to 1 (`deploy/aws/src/storage.ts`; the stack's lifecycle rule and the upload's `expiresAt` both read it). Update the tests and README that say 7 days.
- Keep `tests/cross-cloud/lib/fake-s3.ts` in step (it should refuse a wrong part length and handle the abort), so `bash tests/cross-cloud/run.sh` still passes.

### Fix 2: API Gateway throttling (M2, AWS part)

**Decided by K Marcus:** stage throttling on the HTTP API's default stage: 50 requests a second, burst 100 (`deploy/aws/infra/stack.ts`). Session J1 adds the per-user database counters; this is the platform backstop. Add a stack test for the two numbers.

### Fix 3: a narrow role for the listener functions (L4)

**Decided by K Marcus:** two roles instead of one for the 21 operation Lambdas.
- **Listener role** for `getPublicRelease`, `getPlayback`, `getCover` and `recordPlays`: Data API access; `s3:GetObject` on `streams/*` and `art/*` only (the read grants check the object exists first); `secretsmanager:GetSecretValue` on the CloudFront key secret only, and only for `getPlayback` and `getCover` (a third role, or a per-function policy, is fine; say which). Nothing else: no S3 writes or deletes, no ECS, no PassRole, no Scheduler, no SES, no other secret.
- **Full role** for every other operation, as today.
- Keep it driven by `functions/routes.json` (for example a list of listener operation ids in the stack). Stack tests check that the listener functions lack the write, delete, ECS, Scheduler, SES and other-secret permissions.
- The database secret is read by the Data API with the caller's credentials, so the listener role still needs `secretsmanager:GetSecretValue` on the database secret through `grantDataApiAccess`; that is expected.

### Fix 4: CDK version (L9)

Bump `aws-cdk-lib` in `deploy/aws/package.json` to 2.278.0 or later (the `minimatch` advisory), regenerate `package-lock.json` with `npm install`, and keep `aws-cdk` (the CLI) compatible. Run `npm audit --package-lock-only` and say the result.

### Fix 5: sandbox notes (L8)

No code. **Decided by K Marcus:** process only. Add to the "Sandbox run from GitHub" part of `deploy/aws/README.md` and to the working notes in `docs/phase0-handoff.md`:
- `milkcrate-dev` holds nothing but the Phase 0 sandbox (the sandbox role is close to admin there);
- before approving a run, open it and check its commit is the expected one on `milk-crate-backend-poc`.

### From session D (CI)
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers`, `worker-processing`, `cross-cloud`.
- Run before you push: `bash deploy/aws/test/run.sh` and `bash tests/cross-cloud/run.sh` from the repository root.
- No new CI job is needed. Don't change `.github/workflows/` (including `aws-sandbox.yml`).

### Constraints
- Only these fixes. No change to the contract, the interfaces in `core/`, the database or the other deployments.
- Don't start a sandbox run; list what it should check.
- No real AWS accounts, keys or network calls (the npm registry for the CDK bump is fine). Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/j3-aws-fixes`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/`, `build.yml` or `pages.yml`.
- You get no keys, tokens or passwords. Never print or commit a secret.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description.
- Plain, short wording in comments and descriptions.

### Done when
- The five fixes are in, with tests; `bash deploy/aws/test/run.sh` and `bash tests/cross-cloud/run.sh` pass.
- The pull request description lists what changed, per fix; what you ran and its result; what the next sandbox run must check (the part length refusal, the throttling, the listener role still serving playback and covers); open points and assumptions.

Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

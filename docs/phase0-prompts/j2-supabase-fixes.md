You are session J2 of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to I are merged. Session I's security review is in `docs/security/review-phase0.md`, and K Marcus decided a fix for every finding (the table "Decided by K Marcus" near the end). Four sessions make the fixes, by owner: J1 (database, handlers and both email template files), **J2 (you): session E's Supabase deployment, `deploy/supabase/`**, J3 (AWS, `deploy/aws/`) and J4 (the worker, `worker/`). They can run at the same time. Don't change files the others own; in particular, `deploy/supabase/src/email-templates.ts` is J1's in this round.

Read these first, in this order:
1. `docs/security/review-phase0.md` (findings L5, L7, L9, and the decision table)
2. `docs/phase0-sessions.md` (shared rules, and E's section)
3. `deploy/supabase/README.md`, `deploy/supabase/supabase/config.toml`, `deploy/supabase/supabase/functions/`, `deploy/supabase/scripts/`, `deploy/supabase/test/`

### Fix 1: password rules (L5)

**Decided by K Marcus:** in `deploy/supabase/supabase/config.toml`, under `[auth]`, set `minimum_password_length = 12` and `password_requirements = "lower_upper_letters_digits"`, matching Cognito (12, lower, upper and digits). Check the key names against the Supabase CLI version the stand-up uses (`deploy/supabase/README.md`) and say which you checked. Staff MFA is Phase 1, not now. If E's tests read `config.toml`, add a check that these two settings are there.

### Fix 2: pin the Edge Function's dependencies (L9)

`supabase/functions/deno.json` imports `npm:jose@6.2.3` and `npm:postgres@3.4.9` by exact version, but no `deno.lock` pins their contents.
- Generate `deploy/supabase/supabase/functions/deno.lock` for the `api` function (for example `deno cache --lock=deno.lock --frozen=false supabase/functions/api/index.ts` from `deploy/supabase/`, after `bash scripts/copy-core.sh`). If `deno` isn't installed, `npx deno@<an exact 2.x version>` runs it from npm; say which version.
- Make the deploy use it: check how `supabase functions deploy` picks up a lock file in the CLI version the stand-up uses, and change `scripts/stand-up.sh` only if it needs a flag. Say what you found.
- The lock must not include `_core/` (the copy of `core/src/` that `copy-core.sh` makes, which is git-ignored): only the npm packages.
- If `deno` cannot run here at all, stop at writing what is needed and list it as an open point.

### Fix 3: Resend setup notes (L7)

No code. Live invite codes are in the invitation emails, and Resend keeps sent messages. **Decided by K Marcus:** setup steps only. Add to `deploy/supabase/README.md` (the stand-up section) and to the example `scripts/secrets.env.example` comment for `RESEND_API_KEY`:
- use a Resend API key with **sending access only** (it cannot read emails back);
- 2FA on the Resend account, kept to K Marcus;
- shorten or turn off message retention if Resend offers it.

Also add these three as a checklist item under "Still open" in `docs/phase0-handoff.md`, for after the stand-up.

### Not in this session
- H2's Supabase upload fix is J1's (database and `getUpload`); staging files are Phase 1.
- The template change (release and invitation ids in the invitation email) is J1's.

### From session D (CI)
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers`, `worker-processing`, `cross-cloud`.
- Run before you push: `bash deploy/supabase/test/run.sh` and `bash tests/cross-cloud/run.sh` from the repository root.
- No new CI job is needed. Don't change `.github/workflows/`.

### Constraints
- Only these fixes. No change to the contract, the interfaces, the database or the other deployments.
- No real projects, accounts, keys or network calls (fetching npm packages for the lock file is fine). Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/j2-supabase-fixes`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/`, `build.yml` or `pages.yml`.
- You get no keys, tokens or passwords. Never print or commit a secret.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description.
- Plain, short wording in comments and descriptions.

### Done when
- `config.toml` has the password rules; the function has a `deno.lock` that the deploy uses (or the open point says why not); the Resend notes are in the README, the secrets example and the handoff.
- `bash deploy/supabase/test/run.sh` passes.
- The pull request description lists what changed, what you ran and its result, the CLI and Deno versions you checked, open points and assumptions.

Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

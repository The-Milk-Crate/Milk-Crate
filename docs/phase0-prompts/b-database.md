You are session B of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda). Anything that runs on one must run on the other.

Session A is merged. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and your section, "B: Database")
2. `api/openapi.yaml` (the contract, 21 operations; the table of release state moves is at the top)
3. `core/src/platform/` (the eight interfaces; read `database.ts` closely)
4. `milk-crate/supabase/*.sql` (the app's existing tables and policies; do not change them, and do not reference them: they exist only on Supabase)

Your job: the database. One schema that runs on both Supabase Postgres and Aurora PostgreSQL.

### Build
- Tables for: releases, tracks, cover art, uploads, rights and parties, review decisions, play events, qualified streams, audit rows, jobs, and the account source (below).
- The release state enum (draft, uploading, processing, awaiting_splits, awaiting_review, needs_changes, scheduled, live, failed, taken_down) and the rule that only the server moves a state. Match the state table in the contract. Approve does not change the state; it records `review.decision = approved`.
- Rights: parties with side (recording or composition), role, name, email, percent, and state (invited, accepted, declined). Shares for each side must total 100 at submit.
- Split invite codes: store only a hash of the code, `expires_at` set to 14 days after the invitation is sent, and `used_at`. A code works once. `resendInvitation` replaces the hash and expiry, so the old code stops working. Count sends per party per day. Never store or return the code itself. Also count wrong code attempts per party (for `getInvitation` and `respondToSplit` rate limits).
- The invitation read: a narrow SQL function for `getInvitation`. It takes the release id, the party id and the hash of the code, and returns only the contract's `Invitation` fields (release title, artist name, release date, track titles, and that one party's own side, role, percent and state). It checks the hash and expiry without using up the code, and never exposes other parties, emails or `owner_id`. The invitee has no access to the tables, so this function is their only way in. Session C allows that one path; session G calls it.
- The account source (settled): one portable table, `api_accounts` (not the app's `public.accounts`), with `user_id` (the identity's user id: the Supabase user id or the Cognito `sub`; primary key), `account_type` (any `AccountType` value but `end_user`), `email`, and `artist_id` and `artist_name` (set, and required, only for `artist`). One row per account means one role per account; no row means `end_user`. Refuse, in the database, any change of a row between `artist` and a staff type (a staff member who makes music uses a second account). Both claims read this table: session C fills it on Supabase from `public.admins` and approved artist profiles and writes the hook; session F fills it on AWS. You provide only the table and its rules. `owner_id` and every other account reference point at `api_accounts.user_id`.
- No reference to `auth.*`, `auth.uid()`, `public.admins`, `public.artists` or any other app table anywhere in `db/migrations/`. Those exist only on Supabase; your SQL must run on Aurora and on the plain test cluster. Supabase-only SQL is session C's, in `db/supabase/`.
- Jobs: a table with job id, release id, kind (`process_release`), state, created and finished times, and the plain-words failure message, so a job result finds its release.
- Per track, nullable columns for what playback needs: the streaming copy key (under `streams/{artist}/{release}/{track}/`), duration and sample rate. Session H fills them; session G's `getPlayback` reads the key.
- Play events: a batch with the same idempotency key counts once. The server decides what is a qualified stream (30 seconds or more) from positions and times. The client never sends counts.
- Cover art: a cover per release (format, size, confirmed), kept at `art/{artist}/{release}/cover/original`, and a `kind` (`master` or `cover`) on uploads. A release can be edited only in `draft`, `uploading`, `awaiting_splits` and `needs_changes`; track order is a position per track. The list query returns summaries newest first, with a `state` filter and keyset cursor paging, and works through `Database`.
- Master keys follow `masters/{artist}/{release}/{track}/original`. Store keys, never public URLs.
- SQL functions the schedules and handlers call, such as "make this release live on its date". That one moves only `scheduled` → `live` and does nothing in any other state: a release taken down while scheduled must stay `taken_down`, and `Schedules` cannot cancel a run.
- State rules to match the contract's table, including `failed` → `uploading` (the artist replaces a master).
- Audit rows for takedown, listing what was removed.

### Constraints
- SQL must work through the `Database` interface on both sides: parameters as `$1`, `$2`, no Postgres-only client features. Keep each call's result small (RDS Data API: 1 MB response, 45 seconds).
- Migrations live in `db/migrations/` at the repository root (a sibling of `api/` and `core/`), as numbered plain SQL files (`0001_...sql`, `0002_...sql`). Put the test in `db/test/`. Don't put files in `milk-crate/supabase/`; that folder is the app's own hand-run SQL. `db/supabase/` is session C's (Supabase-only SQL); leave it alone.
- Migrations are safe to run twice. The test uses a throwaway local PostgreSQL 16 and no Docker: a script starts a temporary cluster (PostgreSQL 16 is installed at /usr/lib/postgresql/16/bin; run `initdb` and `pg_ctl` as the `postgres` user on a temp directory and a free port), applies every migration twice, runs the checks below, then stops the cluster and removes the directory. It must clean up even when a check fails. No keys and no network needed. Checks: state rules (including that the scheduled-to-live function leaves a taken-down release alone), the 100-percent rule, idempotent play batches, single-use invite codes, and one role per account in `api_accounts`. Document how to run it in `db/README.md`. Session D will run the same script in CI later, so keep it free of anything specific to this machine.
- Don't write read rules or the claim hook (session C), handlers (session G), or any deployment code (sessions E and F).
- Don't change the app's existing tables, policies, screens or Supabase calls. Add alongside them.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/b-database`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- The migrations apply cleanly to an empty Postgres, twice, and the tests pass.
- `db/test/` runs from a clean checkout with one documented command and leaves no cluster or temp files behind.
- Every table and state in the contract has a home.
- The existing desktop tests still pass (`cd milk-crate && npm test`).
- The pull request description lists: what you built, what you ran and its result, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

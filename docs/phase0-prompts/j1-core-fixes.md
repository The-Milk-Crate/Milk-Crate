You are session J1 of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to I are merged. Session I's security review is in `docs/security/review-phase0.md`, and K Marcus decided a fix for every finding (the table "Decided by K Marcus" near the end). Four sessions make the fixes, by owner:
- **J1 (you)**: session B's database (`db/migrations/`) and session G's handlers (`core/src/handlers/`), plus both copies of the email templates. These fixes depend on each other, so K Marcus routed them to one session, as with G3.
- J2: Supabase deployment (`deploy/supabase/`), `docs/phase0-prompts/j2-supabase-fixes.md`.
- J3: AWS deployment (`deploy/aws/`), `docs/phase0-prompts/j3-aws-fixes.md`.
- J4: the worker (`worker/`), `docs/phase0-prompts/j4-worker-fixes.md`.

The four can run at the same time; their files don't overlap. Don't change files the others own.

Read these first, in this order:
1. `docs/security/review-phase0.md` (the findings you fix: H1, H2, M1, M2, L1, L2, L3, L6, and "Other observations"; then the decision table)
2. `docs/phase0-sessions.md` (shared rules, and the sections for B, C, G)
3. `docs/phase0-handoff.md` (where things stand)
4. `api/openapi.yaml`, `core/src/handlers/`, `core/test/`, `db/migrations/`, `db/test/`, `tests/cross-cloud/`

### Fix 1: qualified streams (H1)

**Decided by K Marcus.** The qualified-stream rule settled with session B ("stays as built for Phase 0") is reopened and tightened now. In `api_record_play_batch`, a new migration (`db/migrations/0009_...`, safe to run twice), a play qualifies only when all of these hold:
- the position moved by 30 seconds or more, and the device time passed by 30 seconds or more (as today);
- **server time:** the play's events were received over at least 15 seconds of server time (the span of `received_at` across its batches). Clients send a batch every 15 to 30 seconds, so a real 30-second play spans at least one batch gap; a whole fake play sent in one request spans 0;
- **track length:** no event's `positionMs` is past the track's `duration_ms` plus 1 second (a track with no `duration_ms` has no streaming copy and cannot be live);
- **no overlap:** its server-time span does not overlap the span of another qualified play by the same user. So one account counts at most one play at a time.

The 15 seconds and 1 second are starting values; keep them as named constants in the SQL and say them in your pull request. Events that don't qualify are kept, as today. Offline listening sent later in one batch no longer qualifies; that is accepted for Phase 0 (say so in `db/README.md`).

**Tests:** session I's reproduction (50 fake plays in one batch, device times in 2020) must count 0. A real play (start, progress 15 seconds of server time later, end) counts once. Two plays overlapping in server time count once. A position past the duration does not count. `db/test/` checks the SQL; `core/test/plays.test.ts` checks through `recordPlays` (it will need a way to set `received_at`, for example a test-only clock; say how).

### Fix 2: uploads after submit (H2, part a)

**Decided by K Marcus:**
- **Database:** moving a release to `awaiting_review` (`submitRelease`) cancels its open uploads (`state = 'cancelled'`), in the same transaction (in B's state rules, so it holds whoever writes).
- **Handler:** `getUpload` answers 409 `upload_closed` (it already does for a closed upload) also when the release's state no longer allows that kind of upload: a master outside `draft`, `uploading`, `needs_changes`, `failed`; a cover outside `draft`, `uploading`, `processing`, `awaiting_splits`, `needs_changes`. Check it before storage, so no token is signed.
- Phase 1 (not now): staging files and a server-side move at confirm.

**Tests:** session I's R3 (open cover upload, then submit, approve, publish) must end with the upload `cancelled` and `getUpload` answering 409. Check `db/test/access-expected.json` (`getUpload` cells) still matches; if a cell must change, ask K Marcus first, as G3 did.

### Fix 3: invitation caps (M1)

**Decided by K Marcus.** Caps on sending invitations, in `putRights` and `resendInvitation`:
- at most 20 invitations per release (all time);
- at most 50 per artist (release owner) per UTC day;
- at most 3 per recipient address per UTC day (compare addresses lowercased and trimmed).

Counters live in the database (a migration; store only what the count needs). The per-party daily limit (5) stays.

Over a cap: `putRights` still saves the party and its state, sends no email, and logs it, as the per-party limit already does; `resendInvitation` answers 429 `rate_limited` with `Retry-After` (seconds to the next UTC day; for the release cap, no `Retry-After` is right, so answer 429 with plain words). No contract change: `putRights` has no 429.

### Fix 4: rate limits (M2)

**Decided by K Marcus.** This replaces the earlier decision in `docs/phase0-handoff.md` step 8 ("not in Phase 0"). Database counters, one small table (a migration), checked in the handlers:
- `recordPlays`: at most 60 batches per user per minute, and at most 10,000 stored events per user per UTC day (10,000 is a starting value; say it in the pull request). Over either: 429 `rate_limited` with `Retry-After`. The batch is not stored.
- `createRelease`: at most 20 per artist per UTC day; 429 with `Retry-After`.
- Processing jobs: at most 2 running per artist at a time. `api_job_started` returns false (the job stays queued) when the release's artist already has 2 running; the worker already does nothing on false, and the hourly sweep runs it later. Say in `db/README.md` that a third job can wait up to an hour.

Both 429s are already in the contract. No 429 on any other endpoint (that would be a contract change).

Count with one statement per call (insert or update returning the count), so concurrent requests cannot both pass. Old counter rows: say how they are cleaned up (for example the hourly sweep, or a delete in the same statement).

### Fix 5: the wrong-code lock (L1)

In `api_get_invitation` and `api_respond_to_invite`: check the code before the lock. A correct, unexpired, unused code works even after 10 wrong codes; wrong codes still count and are still refused with `rate_limited` once locked. Test session I's R2: 10 wrong codes from another account, then the invitee's correct code, answers 200.

### Fix 6: owner shares (L2)

- **Database:** at most one owner party (`is_owner`) per release and side (a partial unique index, in a migration; existing data: say what happens if a release already has two).
- **Handler:** `putRights` refuses a second no-email party on the same side with 422 `bad_parties`, and sets each owner party's `name` from the caller's `api_accounts.artist_name`, ignoring the name sent (the contract still requires one). Test session I's R5.

### Fix 7: cover size (L3)

`confirmUpload` refuses a cover over 6000 pixels on either side with 422 `too_large_image` (or a code word you choose; say it). Add the limit to the contract's `startCoverUpload` description: wording only, no schema change. Then run `cd milk-crate && npm run api:client` and commit `src/lib/api/schema.d.ts` if it changes, and `npm run api:lint`.

### Fix 8: storage error text (L6)

`mapModuleError` (`core/src/handlers/http.ts`) answers a storage 400 with a fixed message ("Storage refused the request.") and the handler logs the detail with the request id. A 413 keeps its plain message (it names the size limit, which the artist needs).

### Fix 9: the invitation email names the invitation (Other observations)

**Decided by K Marcus.** The email must let the invitee find the invitation. Its address as a link (app scheme or web) is decided in Phase 1, with the invitation screen. Now:
- `putRights` and `resendInvitation` pass `releaseId` and `partyId` in the `split_invitation` data;
- both template copies (`deploy/supabase/src/email-templates.ts` and `deploy/aws/src/email-templates.ts`; they must stay the same, and a test checks that) need the two fields and show them in the body as "Release: <id>" and "Invitation: <id>". The code stays in the body only, never in a URL.
- Update `core/test/fakes.ts` (`FakeEmail` lists each template's fields) and the template tests in both deployments.

J2 and J3 don't touch the templates; these two files are yours in this session.

### The cross-cloud suite

Several fixes change behaviour the scenario checks (plays, `getUpload`, invitations, owner names). Keep `bash tests/cross-cloud/run.sh` passing with no known differences: update the scenario's expectations where a fix changes them, the same way on both module sets. If a fix shows a difference between the deployments, report it; don't hide it.

### From session D (CI)
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers`, `worker-processing`, `cross-cloud`.
- Run them yourself before you push:
  - from the repository root: `bash db/test/run.sh`, `bash core/test/run.sh`, `bash deploy/supabase/test/run.sh`, `bash deploy/aws/test/run.sh`, `bash worker/test/run.sh`, `bash tests/cross-cloud/run.sh`;
  - from `milk-crate/`: `npm ci`, `npm run api:lint`, `npm run api:client` (commit `src/lib/api/schema.d.ts` if it changes), `npm run api:core`, `npx tsc --noEmit`, `npm test`.
- New migrations follow session B's rules: numbered after `0008`, safe to run twice, applied whole by psql and split into single statements on the Data API path (`deploy/aws/test/run.sh` checks both give the same schema). C's lock-down must still hold on Supabase (`bash db/test/run.sh`, step 5): new `api_` tables and functions get no client grants.
- No new CI job is needed. Don't change `.github/workflows/`.

### Constraints
- Only these fixes. The contract changes only by fix 7's wording. Any other contract change is an open point for K Marcus.
- Don't change the app's existing tables, policies, screens or Supabase calls.
- No real projects, accounts, keys or network calls. Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/j1-core-fixes`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/`, `build.yml` or `pages.yml`.
- You get no keys, tokens or passwords. Never print or commit a secret.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- The nine fixes are in, each with tests, and session I's reproductions R1 to R5 now fail the way the fixes say (R1 counts 0; R2's correct code works; R3 ends cancelled and 409; R4 stops at the caps; R5 is refused).
- Every required check passes locally.
- The pull request description lists: what changed, per fix; the migrations and what they do to existing rows; the constants and their values; what you ran and its result; open points and assumptions.

Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

You are session I of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to H and the contract changes are merged. This session was not in the original plan. Nothing is running anywhere yet: no real accounts, projects or keys exist. K Marcus will stand it up for real after your review, so what you find can be fixed first.

Your job: a security and abuse review of the merged work. You review and report. You do not fix anything.

Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules, the decisions that were settled, and each session's section)
2. `api/openapi.yaml` (the contract; every operation lists `x-account-types` and `x-state-moves`) and `api/README.md`
3. `core/` (the interfaces in `core/src/platform/` and session G's handlers, router and tests)
4. `db/` (session B's migrations, SQL functions and tests in `db/migrations/` and `db/test/`, and session C's Supabase-only read rules, claim hook and sync in `db/supabase/`), and session F's Cognito account sync in `deploy/aws/`
5. `deploy/supabase/` (session E), `deploy/aws/` (session F) and `worker/` (session H)
6. `.github/workflows/` (session D's checks, and the existing `build.yml` and `pages.yml`)

### What to check
For each area, read the code, trace a realistic attack, and decide whether it works. Write down what you checked even when you found nothing.

1. Authentication. How tokens are verified on each side: signature and key source, algorithm, expiry, audience and issuer, and what happens with a missing, expired, malformed or foreign token. Edge Functions: is JWT verification left on?
2. Authorization against the contract. Build the table of every operation against every account type from `x-account-types`, and check that the handlers and the read rules both enforce it. Ownership checks: can an artist reach another artist's release, upload, track, party, invitation or cover by changing an id (IDOR)? Does a listener or an invitee reach any table directly?
3. The account-type claim. The one-role rule in `api_accounts` and C's sync from the app's tables: can concurrent requests defeat it? Stale tokens after a role change. The both-roles fallback order. Can anyone grant themselves a role?
4. The release state machine. Can any call, replay, race or direct database write move a release to a state the contract forbids (for example publishing without approval, editing a submitted release, or reviving a `taken_down` release)? Is "only the server moves a state" true in the database, or only in the handlers?
5. Invitations. Invite code strength, hashing, constant-time comparison, single use under concurrency, expiry, resend voiding the old code, wrong-code limits, and whether a code can reach logs, error messages, URLs, the email provider's logs or any response.
6. Uploads and keys. Can user input shape an object key (path traversal, a different artist's prefix, `masters/` versus `art/` mix-ups)? Size, format and content checks; checksum checks; the square-cover check on hostile images; confirming an upload that is incomplete or belongs to someone else; presigned URL scope, expiry and bound headers; multipart abuse.
7. Reads. Signed links and CloudFront cookies: lifetime, scope (one object or a whole prefix), binding to the listener, whether a listener can reuse or share a grant, whether a master can ever be signed, and whether a hidden release is distinguishable from a missing one.
8. Plays. Can a client fake qualified streams (fabricated positions and times, many tracks at once, replayed batches)? Is the idempotency key scoped to the user, so one user cannot block or replay another's? Batch size and rate limits.
9. Takedown. Does it really remove access and every file (masters, streaming copies, art)? Can the audit rows be altered or deleted by the people they audit? What if it fails halfway?
10. Injection and input handling. SQL built from input anywhere (every query should be parameterised), header and email injection in templates, unbounded request sizes, JSON edge cases, and error messages that leak internals.
11. Secrets and configuration. Search the whole repository, including history on these branches, for keys, tokens and passwords. Check the stand-up scripts and infrastructure definitions: least-privilege IAM, storage and bucket public access, CORS, bucket and storage policies, the Supabase service role key never reaching a client or a log, Cognito and Supabase auth settings, the worker's permissions.
12. Rate limits and abuse. Where limits exist and where they are missing: wrong invite codes, resends, play batches, uploads, listing, email sending (can the system be used to spam anyone?).
13. Dependencies and workflows. Third-party packages in `core/`, `worker/`, `deploy/` and `tests/` (versions, lockfiles, anything unusual; run an audit if the network allows it and say so if it does not). Workflow permissions, pinned actions, and any path where a pull request could run untrusted code with secrets.
14. The desktop app's new client in `milk-crate/src/lib/api/`: how it handles tokens and errors.

### How to work
- Read-only. Don't change any code, contract, migration, workflow, script or setting. The only file you add is the report.
- To prove a finding, you may reproduce it on session B's throwaway local PostgreSQL 16 or with the existing mocks, using scratch files that you do not commit. Put the steps and the result in the report.
- No network calls to anything real. There is nothing real to attack, and you must not try.
- Mark each finding `confirmed` (you reproduced it or the code plainly does it) or `suspected` (needs a real environment to know). Say which.
- Don't stretch. A finding needs a realistic path from an attacker's action to harm. List theoretical concerns separately, briefly.

### The report
One file, `docs/security/review-phase0.md`, with:
- A summary: how many findings at each severity, and the five that matter most.
- Each finding: a short title; severity (critical, high, medium, low) and why; `confirmed` or `suspected`; where it is (file and line); how an attacker uses it; how to fix it in a sentence or two; and which session or folder owns the fix.
- A "checked, nothing found" list, by the 14 areas above.
- What you could not check here (for example live account settings, real CloudFront or Supabase behaviour) and what K Marcus should check by hand after stand-up.
- A short list of decisions for K Marcus, if any fix needs one.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/i-security-review`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/`. `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret. If you find a real secret in the repository, don't paste it into the report or the pull request: give the file and line, say what kind of secret it looks like, and tell K Marcus to rotate it.
- The contract is fixed. If a finding needs a contract change, say so in the report; don't edit it.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses.
- Plain, short wording.

### Done when
- Each of the 14 areas has been reviewed and has either findings or a "checked, nothing found" line.
- Every `confirmed` finding has a reproduction or a plain code path in the report.
- The report is the only file added, and `git diff origin/milk-crate-backend-poc --stat` shows nothing else.
- The pull request description lists: the severity counts, the five most important findings, what you could not check, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request. Fixes go back to the sessions that own the code.

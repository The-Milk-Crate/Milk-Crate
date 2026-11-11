You are session C of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda). Anything that runs on one must run on the other.

Sessions A and B are merged. Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules and your section, "C: Read rules and the account-type claim")
2. `api/openapi.yaml` (the contract, 17 operations; each operation lists `x-account-types`, and the top of the file has the table of release state moves)
3. `api/README.md` (who may call what)
4. `core/src/platform/` (the eight interfaces; read `identity.ts` and `database.ts`)
5. `db/` (session B's migrations, tests and README)
6. `milk-crate/supabase/003_accounts_and_places.sql` (today's `public.admins`, `is_admin()` and `is_approved_artist()`; do not change them)

Your job: the account-type claim and the read rules. Both deployments must give each account type the same view of the data.

### Build
- The `account_type` claim: one name, with the values in the contract's `AccountType` (`end_user`, `artist`, `third_party`, `administrator`, `internal`, `internal_accounting`).
  - Supabase: a custom access token hook that puts it in the token.
  - AWS: Cognito groups with the same names.
  - Both read the same source (below).
- Source of the claim (settled):
  - Every `public.admins` row means `administrator`.
  - Session B's staff table `(user_id, account_type)` holds `internal`, `internal_accounting` and `third_party`. Use it; don't create it.
  - An account with an approved artist profile (what `is_approved_artist()` checks today) gets `artist`.
  - Everyone else is `end_user`. Pending and declined applicants stay `end_user` until a reviewer approves them.
- One role per account (settled). Staff types and `artist` are mutually exclusive. Session B enforces that in the database; you test it. If both ever exist anyway, the claim takes the higher-privilege type (`administrator`, `internal`, `internal_accounting`, `third_party`, `artist`, `end_user`, in that order) and the artist endpoints refuse them.
- The claim is read when the token is issued, so a role change shows after the token refreshes. Say so in your tests and notes.
- Read rules for session B's tables:
  - Listeners see only `live` releases.
  - The public view hides `owner_id`, rights and review details, and anything not `live`.
  - An artist sees only their own releases, in any state.
  - `administrator` and `internal` see what the contract says they see.
  - Match each operation's `x-account-types` and the notes in `api/README.md`.
  - Playback and play events follow the contract (owner and reviewers may get a grant for a release that is not live; everyone else gets 404).
- The invitee path: `getInvitation` and `respondToSplit` are called by accounts that have no rights to the release rows. Don't open the tables to them. Allow only session B's narrow invitation function (and the one write that records a reply) on both sides. Test that an invitee with a valid code sees only the `Invitation` fields and nothing else, and that a wrong or expired code sees nothing.
- Supabase: row level security policies and the hook, as migrations added alongside the app's existing ones.
- AWS: the equivalent checks on Aurora. Aurora through the RDS Data API uses one shared database login, so row level security by caller does not work the same way there. Propose how the checks work on that side (for example, views or functions that take the caller's id and account type as arguments, so every query through `Database` carries them). Write your proposal in the pull request as an open point for K Marcus, and build the part that doesn't depend on the answer.
- Tests that sign in as each account type and check what each can read: one set for the Supabase rules, one for the Aurora-side checks, with the same expected results in both.

### Constraints
- Reuse session B's test approach in `db/test/` (a throwaway local PostgreSQL 16, no Docker). Put your tests beside it, and keep them free of anything specific to this machine, because session D runs them in CI.
- Don't change the app's existing tables, policies, functions, screens or Supabase calls. Add alongside them.
- Don't write the staff table or the exclusion rule (session B), handlers (session G), or deployment code (sessions E and F). The hook's wiring into a real Supabase project and a real Cognito pool is for E and F; you write the hook function, the group names and the tests.
- SQL must work through the `Database` interface on both sides where handlers use it: parameters as `$1`, `$2`, small results.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/c-read-rules`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- Tests prove each account type reads only what the contract allows, with the same results on the Supabase rules and the Aurora-side checks.
- Tests cover: the claim for each source (admins row, staff row, approved artist, pending and declined applicants, everyone else), the both-roles fallback order, and a role change that only shows after refresh.
- Nothing existing in the app's tables, policies or screens changed, and `cd milk-crate && npm test` still passes.
- The pull request description lists: what you built, what you ran and its result, the open points for K Marcus (including how the Aurora checks work), and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

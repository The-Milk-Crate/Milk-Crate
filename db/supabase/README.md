# Supabase-only SQL (session C)

The account-type claim, the account sync and the read rules. Applied on Supabase only, after
`db/migrations/`, in the same stand-up step (session E). Never on Aurora: Aurora has one shared
login, so there the handlers (session G) are the only check. Numbered plain SQL, safe to run twice.

| File | What |
|---|---|
| `0001_lock_down.sql` | Row level security on every `api_` table; takes Supabase's default grants on `api_` tables, sequences and functions back from `anon`, `authenticated` and `public`. |
| `0002_account_claim.sql` | `api_account_claim(user)` and the custom access token hook `api_access_token_hook(event)`. |
| `0003_account_sync.sql` | Triggers that keep `api_accounts` in step with `public.admins`, `public.artists` and `auth.users`, and a backfill. |
| `0004_read_rules.sql` | Backstop policies on the release tables, the public views, and `api_can_play_track` / `api_can_read_cover`. None is granted to clients. |
| `0005_invitee.sql` | The invitee wrappers `api_client_get_invitation` and `api_client_respond_to_invite`. |
| `0006_grants.sql` | Runs the lock-down again, then grants back only the two invitee wrappers and the hook. |

Tests: `bash db/test/run.sh` (step 5). It loads the app's SQL on a test-only stand-in for
Supabase's roles, `auth` and `storage` (`db/test/supabase-standin.sql`), then `db/migrations/`,
then this folder twice, and runs `db/test/supabase-checks.sql` against the shared fixture
`db/test/access-expected.json`. It also fails if anything of the app's own changed.

## The claim

- Name `account_type`, values as the contract's `AccountType`. Defined for both deployments in
  `db/account-claim.json` (Cognito group names and precedence for session F).
- Source: `api_accounts`. No row means `end_user`. A suspended row means `end_user` (settled);
  on AWS that is no group.
- The hook puts it at the top level of the token's claims and overwrites any `account_type`
  already there. It never reads `user_metadata`, which users can change; read the claim from
  the top level only.
- Wiring (session E): enable the hook with
  `uri = "pg-functions://postgres/public/api_access_token_hook"` under
  `[auth.hook.custom_access_token]`. Only `supabase_auth_admin` may run it.
- **The claim is read when the token is issued.** A role change shows only after the token
  refreshes (Supabase's default token life is an hour). The backstop policies and the invitee
  wrappers also compare the token's claim with `api_account_claim()` and treat a mismatch as
  `end_user`, so a new role waits for the refresh but a removed or suspended role stops at once
  there. Handlers that trust the token alone keep the old role until the refresh; B's functions
  check the row.

## The sync

| App's tables | `api_accounts` |
|---|---|
| A `public.admins` row | `administrator` (with the email) |
| An approved artist profile (`public.artists.status = 'approved'`) | `artist` with the profile's id and name and the email |
| Pending or declined profile | no row (`end_user`) |
| — | `internal`, `internal_accounting`, `third_party` are written straight into `api_accounts`; the sync never adds, changes or removes them, only keeps their email in step |

- One role per account. Refused with `MC403 one_role`: an artist approval for an account with any
  other row or an admins row; an admins row for an account with an artist row, an approved
  profile, or another staff or `third_party` row. The app's own change fails with that error.
- Both anyway (rows from before the sync, or triggers off): the higher type wins in the order
  `administrator`, `internal`, `internal_accounting`, `third_party`, `artist`, `end_user`. An
  artist row cannot change type (B), so it is replaced when the account has no history and
  suspended when it has.
- Losing a role (admins row deleted, profile no longer approved or deleted): the row is deleted
  when the account has no history, suspended when B refuses the delete (`MC409 has_history`).
  Getting the same role back lifts the suspension.
- Email changes in `auth.users` reach every row.

## What clients may reach

Settled: clients read the new slice only through the API (session G's handlers). So:

- `anon`: nothing.
- `authenticated`: only `api_client_get_invitation` and `api_client_respond_to_invite`, for
  `end_user`, `artist` and `third_party` with the code (B's status and the `Invitation` fields).
- `supabase_auth_admin`: only the hook.

No table, view or read-rule helper is granted to clients. The policies in `0004` stay as a
backstop in case a read grant comes back by mistake (for example Supabase's default grants on a
new table, until `db/supabase/` runs again). The tests grant the list below inside a
rolled-back transaction and check every account type against the fixture. If a direct read is
ever wanted, grant exactly this:

| Object | Who sees which rows | Columns |
|---|---|---|
| `api_releases` | owner (artist) any state; `administrator`, `internal` all | all |
| `api_tracks`, `api_parties`, `api_covers` | follow the release | no keys, hashes, invite codes, invite times or responder |
| `api_uploads` | owner only | no `provider_upload_id` or checksums |
| `api_public_releases`, `api_public_tracks` | everyone signed in; `live` only | no `owner_id`, rights or review details |
| `api_can_play_track(track)`, `api_can_read_cover(release)` | owner, `administrator`, `internal` any state but `taken_down`; others `live` | true or false for the caller |

Never: `api_accounts`, `api_jobs`, invite counters, play events and streams, review history,
audit rows, and every other `api_` function (takedown, review, publish, list, the raw invite
functions, the sync, the hook). `service_role` and the owner keep their default access; the
server connection uses one of them (session E).

The invitee wrappers take the code, hash it as the server does (SHA-256 of the UTF-8 code,
lowercase hex), pass `auth.uid()` as the replying account, and take no user id.

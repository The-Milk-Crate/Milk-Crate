# Database (Phase 0)

One schema for both deployments: Supabase Postgres and Aurora PostgreSQL (through the RDS Data
API). It holds releases, tracks, cover art, uploads, rights and parties, review decisions, play
events, qualified streams, audit rows, jobs and the account source.

| Folder | What | Runs on |
|---|---|---|
| `db/migrations/` | Numbered plain SQL files, applied in order. Safe to run twice. | Both |
| `db/supabase/` | Supabase-only SQL (session C): read rules, the claim hook, the account sync. Applied after `db/migrations/`. See `db/supabase/README.md`. | Supabase |
| `db/account-claim.json` | The `account_type` claim for both deployments: values, Cognito group names, suspended and precedence rules. | Both |
| `db/test/` | The checks, on a throwaway local PostgreSQL. | Your machine and CI |

`milk-crate/supabase/` is the desktop app's own hand-run SQL. Nothing here changes or reads it.

## Run the checks

```bash
bash db/test/run.sh
```

It needs PostgreSQL 16 server binaries (`initdb`, `pg_ctl`, `psql`, `pg_dump`). It looks in
`/usr/lib/postgresql/16/bin`, then `pg_config --bindir`, then `PATH`. Set `PG_BIN` to use
another directory. No Docker, no keys, no network.

What it does:

1. Checks that `db/migrations/` names nothing from the `auth` schema and none of the app's tables.
2. Starts a temporary cluster in a new temp directory, on a free port on 127.0.0.1. (As root it
   runs `initdb` and `pg_ctl` as the `postgres` user, because `initdb` refuses root.)
3. Applies every migration twice and checks the second run left the schema unchanged.
4. Runs `db/test/checks.sql`: state rules (including that the scheduled-to-live function leaves a
   taken-down release alone), the 100-percent rule, idempotent play batches, single-use invite
   codes, one role per account, and the list query.
5. Supabase only (session C): in a second database, loads a test-only stand-in for Supabase's
   roles, `auth` and `storage` (`db/test/supabase-standin.sql`), the app's SQL from
   `milk-crate/supabase/`, `db/migrations/`, then `db/supabase/` twice. Checks the second run
   changed nothing and the app's own objects are unchanged, then runs
   `db/test/supabase-checks.sql` against the shared fixture `db/test/access-expected.json`.
6. Stops the cluster and deletes the temp directory, also when a check fails.

It prints `ok - ...` per check and exits non-zero on the first failure.

## Names

Every table and function starts with `api_`, because the app already has `public.releases`,
`public.tracks` and `public.plays`. Everything is in the `public` schema.

## Tables

| Table | Holds |
|---|---|
| `api_accounts` | The account source for the `account_type` claim. One row per account (`user_id`: Supabase user id or Cognito `sub`); no row means `end_user`. `artist_id` and `artist_name` only for `artist`. An artist row stays an artist. `suspended` keeps the row (and its releases) but stops the account acting. |
| `api_releases` | The release, its `state`, `failure_reason`, and the current review decision (`review_decision`, `review_reason`, `review_decided_at`). `owner_id` points at `api_accounts`. `artist_id` is copied from the owner at creation. |
| `api_tracks` | Tracks with `position` (order) and `title`; the confirmed master (`master_key`, `master_sha256`, ...); and what playback needs: `stream_key`, `duration_ms`, `sample_rate_hz` (session H fills them). |
| `api_uploads` | Master and cover uploads: `kind` (`master` or `cover`), `method`, the storage module's `provider_upload_id`, `object_key`, `state` (`open`, `confirmed`, `replaced`, `cancelled`). |
| `api_covers` | The confirmed cover, one per release (format, size, width, height). No row means no cover. |
| `api_review_decisions` | Every review decision, with the reviewer. |
| `api_parties` | Rights: side, role, name, email, percent, state (`invited`, `accepted`, `declined`), `is_owner` (the owner's own share), the invite code hash, sent, expiry and used times, and the account that replied. |
| `api_invite_sends` | Invitations sent per party per day (UTC). |
| `api_invite_wrong_codes` | Wrong invite codes per party, with times. |
| `api_jobs` | Jobs: release, kind (`process_release`), state (`queued`, `running`, `succeeded`, `failed`), times, failure message. |
| `api_play_batches` | One row per (listener, `Idempotency-Key`), with a hash of the events. |
| `api_play_events` | The events as sent (`start`, `progress`, `end`), with device and server times. |
| `api_qualified_streams` | One row per qualified play. |
| `api_audit_log` | Takedown rows: who, why, and what was removed (prefixes and keys). |

Object keys follow `masters/{artist}/{release}/{track}/original`,
`art/{artist}/{release}/cover/original` and `streams/{artist}/{release}/{track}/...`, where
`{artist}` is the artist profile id. Triggers refuse any other key. Keys only, never URLs.

## Rules the database enforces

Triggers enforce these whoever writes the row:

- **State moves.** Only the moves in the table at the top of `api/openapi.yaml`
  (`api_release_move_allowed`). A new release is `draft`. Nothing leaves `taken_down`.
- **Submit** (`awaiting_splits` to `awaiting_review`): every track has a confirmed master, track
  positions run 1 to n, each side's shares total exactly 100, and no party declined. Submit
  clears the review decision.
- **Approve does not change the state.** `review_decision = approved` is recorded only while
  `awaiting_review`. `needs_changes` is set only together with the move to `needs_changes`.
  `scheduled` and `live` need `approved`.
- **Leaving `failed`** clears `failure_reason`. `failed` needs one.
- **Editing.** Title, release date, track titles and track order change only in `draft`,
  `uploading`, `awaiting_splits` and `needs_changes`. Tracks are added only in `draft` and never
  removed. Rights change only in `draft`, `uploading`, `processing`, `awaiting_splits` and
  `needs_changes`.
- **Parties.** A new party is `invited` with no code. The owner's own party (`is_owner`) is
  `accepted` at once, gets no code, and stays accepted when its share changes. Any other party
  whose details change goes back to `invited` and its code is voided. A reply moves `invited` to
  `accepted` or `declined`, once, and only by using up a code.
- **Invite codes.** Only a SHA-256 hash (64 lowercase hex). Expiry is exactly 14 days after the
  send. After 10 wrong codes in an hour, a party's invitation is locked (`rate_limited`) for the
  rest of that hour, even for the right code.
- **Accounts.** An artist account stays an artist, and no other account becomes one (a staff
  member who makes music uses a second account). One row per `user_id`. An account that owns a
  release, made a review decision or took a release down cannot be deleted: set `suspended`.
  A suspended account cannot create releases, review, take down or list. Session C decides which
  claim a suspended account gets (suggested: `end_user`).

## Functions

Handlers (session G), workers and schedules call these. Each returns a few rows at most.

| Function | For |
|---|---|
| `api_upload_key(release, track, kind)` | The key to pass to `ObjectStorage.startUpload`. |
| `api_start_upload(release, track, kind, method, provider_upload_id, format, size_bytes, expires_at)` | `startUpload` / `startCoverUpload`. Replaces an open upload for the same target; for a master clears the old master and streaming copy and moves `draft`, `needs_changes` or `failed` to `uploading`. |
| `api_confirm_upload(upload, sha256, crc64nvme, width, height)` | `confirmUpload`. Masters: when every track is confirmed, `uploading` moves to `processing` and `start_processing` is true (then queue the job). Covers: must be square; replaces the cover. |
| `api_create_job(release, 'process_release')` | `Jobs.enqueue`: the job row. |
| `api_job_started(job)` | The worker picked the job up. |
| `api_apply_job_result(job, ok, message)` | The job result. Moves `processing` to `awaiting_splits` or `failed` only for the release's newest job. Safe to call twice. |
| `api_record_review(release, reviewer, 'approve' or 'needs_changes', reason)` | `reviewRelease`. Reviewer must be `administrator` or `internal` and not the owner. |
| `api_publish_release(release)` | `publishRelease`. Returns `scheduled` (release date after today, UTC) or `live`. |
| `api_release_go_live(release)` | The schedule on the release date. Moves only `scheduled` to `live`; does nothing otherwise. Call with the named argument `p_release_id`. |
| `api_takedown_release(release, actor, reason)` | `takedownRelease`. Administrator only. Writes the audit row, clears streaming keys and the cover row, cancels open uploads, moves to `taken_down`, and returns the prefixes to delete. |
| `api_takedown_files_deleted(audit)` | Storage deleted the prefixes. |
| `api_list_releases(caller, state, limit, after_created_at, after_id)` | `listReleases`. Newest first. Staff see all, an artist their own, others nothing. Keyset paging; ask for limit + 1 to learn if there is a next page (at most 101). |
| `api_issue_invite(party, code_hash, daily_limit)` | Send or resend an invitation. Status `issued`, `not_found`, `not_invited`, `taken_down` or `rate_limited`. |
| `api_invite_wrong_count(party, window_seconds)` | Wrong codes in the window, if G wants a stricter limit than the built-in 10 an hour. |
| `api_get_invitation(release, party, code_hash)` | `getInvitation`. Only the `Invitation` fields. Does not use up the code. Status `ok`, `not_found`, `rate_limited`, `wrong_code`, `replied`, `taken_down` or `expired`. `SECURITY DEFINER`. |
| `api_respond_to_invite(release, party, code_hash, user, 'accept' or 'decline')` | `respondToSplit`. Uses up the code and links the account. Same statuses. `SECURITY DEFINER`. |
| `api_record_play_batch(user, idempotency_key, events_json)` | `recordPlays`. Status `ok`, `duplicate` or `conflict` (same key, other events). Returns the qualified streams it added. |

The invite functions return a status instead of raising, because they record wrong codes: commit
the transaction even when the status is `wrong_code`.

A play qualifies once per `playId` when both the position moved and the device time passed by 30
seconds or more (the smaller of the two counts), and the release is `live`. Events for a release
that is not live are kept but never qualify.

## Errors

Rules raise a SQLSTATE and a message that starts with a code word, for example
`wrong_state: a release cannot move from draft to live`.

| SQLSTATE | HTTP | Meaning |
|---|---|---|
| `MC403` | 403 | Account type or owner may not do this. |
| `MC404` | 404 | No such release, track, upload or job. |
| `MC409` | 409 | Wrong state for this call. |
| `MC422` | 422 | Well formed but not acceptable (shares not 100, bad key, not square, ...). |

Plain constraint errors (`23xxx`) mean the caller sent something the schema never allows.

## Calling through `Database`

- Use `$1`, `$2` and cast in the SQL text: `select * from api_start_upload($1::uuid, $2::uuid, ...)`.
  The Data API sends most values as strings, so a cast picks the right function.
- Pass lists as JSON text and cast with `::jsonb` (the Data API has no array parameters).
- Results come back as strings for `numeric` (`percent`), `bigint`, `date`, `timestamptz` and
  `jsonb` on the Data API; `node-postgres` parses `jsonb` and returns `numeric` and `bigint` as
  strings. Read them the same way on both.
- Keep timestamps from `api_list_releases` exactly as returned when building the next cursor.

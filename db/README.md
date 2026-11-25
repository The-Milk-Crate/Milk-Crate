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
3. Applies every migration twice and checks the second run left the schema unchanged. Then
   checks two migrations against data written before them: `0008` numbers existing parties,
   and `0013` stops (changing nothing) when a release already has two owner shares on a side.
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
| `api_uploads` | Master and cover uploads: `kind` (`master` or `cover`), `method`, the storage module's `provider_upload_id`, `object_key`, `state` (`open`, `confirmed`, `replaced`, `cancelled`: the release was submitted or taken down). |
| `api_covers` | The confirmed cover, one per release (format, size, width, height). No row means no cover. |
| `api_review_decisions` | Every review decision, with the reviewer. |
| `api_parties` | Rights: side, role, name, email, percent, state (`invited`, `accepted`, `declined`), `is_owner` (the owner's own share), the invite code hash, sent, expiry and used times, the account that replied, and `position` (the party's place in the `putRights` request, from 0; added by `0008`). |
| `api_invite_sends` | Invitations sent per party per day (UTC). |
| `api_invite_wrong_codes` | Wrong invite codes per party, with times. |
| `api_jobs` | Jobs: release, kind (`process_release`), state (`queued`, `waiting` (its artist had 2 running; added by `0014`), `running`, `succeeded`, `failed`), times, failure message. |
| `api_play_batches` | One row per (listener, `Idempotency-Key`), with a hash of the events. |
| `api_play_events` | The events as sent (`start`, `progress`, `end`), with device and server times. |
| `api_qualified_streams` | One row per qualified play, with its server-time span (`first_received_at`, `last_received_at`; added by `0010`, empty for rows from before it). |
| `api_rate_counters` | Rate limit counters (`0009`): one row per bucket, subject and window (a UTC minute, a UTC day, or all time). The subject is a user id, a release id, or the SHA-256 of an email address, never the address. |
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
- **Submit closes uploads** (`0011`). Moving a release to `awaiting_review` cancels its open
  uploads, in the same transaction, so no upload token can change a reviewed file.
- **Parties.** A new party is `invited` with no code. The owner's own party (`is_owner`) is
  `accepted` at once, gets no code, and stays accepted when its share changes. At most one owner
  party per release and side (`0013`, a unique index). Any other party
  whose details change goes back to `invited` and its code is voided. A reply moves `invited` to
  `accepted` or `declined`, once, and only by using up a code.
- **Invite codes.** Only a SHA-256 hash (64 lowercase hex). Expiry is exactly 14 days after the
  send. After 10 wrong codes in an hour, wrong codes for that party are refused
  (`rate_limited`, not counted) for the rest of that hour. The right code is checked first, so it
  still works (`0012`, finding L1).
- **Invitation caps** (`0012`, in `api_issue_invite`, on top of the sends per party per UTC day,
  which the caller passes: 3 in the handlers, the same as the per-address cap): 20 parties invited per release, all time (each party counts once, at
  its first invitation; a removed party still counts); 50 invitations per artist (the release
  owner) per UTC day; 3 per recipient address per UTC day, compared lowercased and trimmed.
- **Processing jobs** (`0014`): at most 2 running per artist. `api_job_started` returns false
  for a third and marks it `waiting`, so the sweep (which runs only `queued` jobs) goes on to
  other artists' jobs. When one of the artist's jobs finishes, `api_apply_job_result` queues
  their oldest waiting job again and the hourly sweep runs it, so a third job can wait up to an
  hour after a place frees. A job running longer than 4 hours (the job limit) does not count.
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
| `api_job_started(job)` | The worker picked the job up. False when the job is not queued, or its artist already has 2 jobs running (then the job is marked `waiting`). |
| `api_apply_job_result(job, ok, message)` | The job result. Moves `processing` to `awaiting_splits` or `failed` only for the release's newest job. Safe to call twice. |
| `api_record_review(release, reviewer, 'approve' or 'needs_changes', reason)` | `reviewRelease`. Reviewer must be `administrator` or `internal` and not the owner. |
| `api_publish_release(release)` | `publishRelease`. Returns `scheduled` (release date after today, UTC) or `live`. |
| `api_release_go_live(release)` | The schedule on the release date. Moves only `scheduled` to `live`; does nothing otherwise. Call with the named argument `p_release_id`. |
| `api_takedown_release(release, actor, reason)` | `takedownRelease`. Administrator only. Writes the audit row, clears streaming keys and the cover row, cancels open uploads, moves to `taken_down`, and returns the prefixes to delete. |
| `api_takedown_files_deleted(audit)` | Storage deleted the prefixes. Called by the sweep's late pass, 2 hours or more after the takedown. |
| `api_list_releases(caller, state, limit, after_created_at, after_id)` | `listReleases`. Newest first. Staff see all, an artist their own, others nothing. Keyset paging; ask for limit + 1 to learn if there is a next page (at most 101). |
| `api_issue_invite(party, code_hash, daily_limit)` | Send or resend an invitation. Status `issued`, `not_found`, `not_invited`, `taken_down`, `rate_limited` (the per-party daily limit), or a cap: `release_limited`, `artist_limited`, `address_limited`. |
| `api_invite_wrong_count(party, window_seconds)` | Wrong codes in the window, if G wants a stricter limit than the built-in 10 an hour. |
| `api_get_invitation(release, party, code_hash)` | `getInvitation`. Only the `Invitation` fields. Does not use up the code. Status `ok`, `not_found`, `rate_limited`, `wrong_code`, `replied`, `taken_down` or `expired`. `SECURITY DEFINER`. |
| `api_respond_to_invite(release, party, code_hash, user, 'accept' or 'decline')` | `respondToSplit`. Uses up the code and links the account. Same statuses. `SECURITY DEFINER`. |
| `api_record_play_batch(user, idempotency_key, events_json, received_at)` | `recordPlays`. Status `ok`, `duplicate`, `conflict` (same key, other events), `too_many_batches` or `too_many_events` (over a limit: nothing stored; `retry_after_seconds` says how long to wait). Returns the qualified streams it added. `received_at` is the server receive time: leave it out (the database's clock) except in tests. |
| `api_rate_hit(bucket, subject, amount, now)` | Adds to a rate counter in one statement, only while that stays within the cap. Returns `allowed`, `hits`, `cap` and `retry_after_seconds` (to the next window; null for all time). `now` null is the database's clock. Each hit deletes its subject's rows from earlier windows. |
| `api_rate_limit(bucket)` | The cap of each bucket, in one place. |

The invite functions return a status instead of raising, because they record wrong codes: commit
the transaction even when the status is `wrong_code`.

A play (one `playId`, one track) qualifies once, on a `live` release, when all of these hold
over its events so far (`0010`, finding H1; this reopens the rule first settled with session B):

- the position moved and the device time passed by 30 seconds or more (the smaller counts);
- its events were received over at least 15 seconds of server time (the span of `received_at`
  across its batches). A whole play sent in one request spans 0;
- no event's position is past the track's `duration_ms` plus 1 second. A track with no
  `duration_ms` has no streaming copy and never qualifies;
- its server-time span does not overlap another qualified play by the same account, so one
  account counts at most one play at a time.

15 seconds and 1 second are starting values, named constants in `api_record_play_batch`.
Events that do not qualify are kept. **Offline listening sent later in one batch no longer
qualifies** (it spans no server time); accepted for Phase 0.

`recordPlays` limits, per account: 60 batches a minute (every call counts, duplicates included)
and 10,000 stored events a UTC day (10,000 is a starting value). Over either, nothing is stored.

## Rate limits

Counters in `api_rate_counters` (`0009`), with the caps in `api_rate_limit`:

| Bucket | Cap | For |
|---|---|---|
| `play_batches_minute` | 60 per user per UTC minute | `recordPlays` |
| `play_events_day` | 10,000 stored events per user per UTC day | `recordPlays` |
| `releases_day` | 20 per artist per UTC day | `createRelease` (the handler calls `api_rate_hit`) |
| `invites_release` | 20 parties per release, all time | `api_issue_invite` |
| `invites_artist_day` | 50 per artist per UTC day | `api_issue_invite` |
| `invites_address_day` | 3 per recipient address per UTC day | `api_issue_invite` |

Each count is one statement (insert, or update only while under the cap, returning the count),
so two requests at the same moment cannot both pass. Old rows: each hit deletes its own
subject's rows from earlier windows in the same statement, so a subject keeps at most one row
per bucket; a subject that never comes back leaves one small row. Counting started with `0009`:
sends and releases from before it are not counted.

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

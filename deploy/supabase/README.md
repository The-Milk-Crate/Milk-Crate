# Supabase deployment (Phase 0, session E)

The platform interfaces in `core/src/platform/` on Supabase (Auth, Postgres, Storage, Edge
Functions on Deno) with a worker on Fly Machines, and the scripts that stand it up. The shared
handlers are session G's; nothing here is a handler.

## Run the tests

```bash
bash deploy/supabase/test/run.sh
```

Needs Node 22.18 or newer (it runs the TypeScript as is) and PostgreSQL 16 server binaries (set
`PG_BIN` to pick them). It installs the packages if needed (`npm ci`), type-checks, starts a
throwaway cluster like `db/test/run.sh`, loads session C's test-only Supabase stand-in and a
pg_cron stand-in, applies the stand-up SQL twice with `scripts/apply-sql.sh` (checking the
second run changes nothing), runs every test, then removes the cluster. No keys, no Docker, no
network beyond the package install. Supabase Storage, the Management API, Fly and Resend are
mocked at their HTTP edges.

`npm run test:unit` runs only the tests that need no database.

## Layout

| Path | What |
|---|---|
| `src/identity.ts` | `Identity`: verifies the Supabase access token (the project's JWKS; the legacy HS256 secret only if set) and reads the top-level `account_type` claim. Never `user_metadata`. |
| `src/storage.ts` | `ObjectStorage`: `tus` uploads, the size check, signed reads, ranged `readHead`, delete by prefix. |
| `src/jobs.ts`, `src/fly.ts` | `Jobs`: rows in `api_jobs`; a Fly machine per job. |
| `src/schedules.ts`, `sql/0001_schedules.sql` | `Schedules` on pg_cron. |
| `src/functions.ts`, `src/edge.ts` | `ServerFunctions`: the Edge Function adapter, and the two-line entry point helper. |
| `src/secrets-email.ts`, `src/email-templates.ts` | `SecretsAndEmail`: Edge Function secrets; email through Resend. |
| `src/database.ts` | `Database`: postgres.js, pooled, with transactions. |
| `src/infrastructure.ts`, `scripts/` | `Infrastructure`: stand up, confirm, tear down. |
| `src/modules.ts` | Builds all the modules from the environment. |
| `sql/0002_buckets.sql` | The three private buckets and their limits. |
| `worker/` | The worker skeleton for Fly, its image and the hourly sweep. |
| `supabase/config.toml` | Supabase CLI settings: the access token hook, token life, the file size limit. |
| `supabase/functions/` | Edge Function entry points (none yet: they wait on session G). |
| `fly/fly.toml` | The Fly app for the worker image. |

## How each part works

**Database.** postgres.js. Parameters as `$1`, `$2`; the values never go into the SQL text.
Lists and objects go as JSON text and dates as ISO text, as the RDS Data API sends them, so
the same SQL works on both sides. Dates and timestamps come back as text (with their
microseconds, for keyset cursors); `numeric` and `bigint` as text; `json` and `jsonb` parsed.
A Postgres error becomes a `DatabaseError` with `code` (the SQLSTATE, such as `MC409`) and
the message unchanged. `prepare: false`, for the pooler in transaction mode.

**The connection role.** `postgres`, the owner that applied `db/migrations/`. It keeps full
access after session C takes the default grants back from `anon` and `authenticated`, and it
owns the pg_cron jobs. `service_role` cannot log in to Postgres (it is the role the REST API
switches to), so it is not an option for a database connection. Edge Functions connect through
the transaction pooler (port 6543), the worker through the session pooler or directly.

**Uploads (`tus`).** `startUpload` signs an upload token for the one object (about two
hours), opens a TUS upload with `Upload-Length` set to the declared size, and returns the
upload URL as `endpoint` with `x-signature` (the token), `x-upsert` and the publishable key as
`headers`. The client sends the file there (6 MB chunks, Supabase's TUS rule). The secret key
never leaves the server. `getUpload` reads `Upload-Offset` with a fresh token, so an
interrupted upload resumes from what is stored. `providerUploadId` is the upload URL with the
start time and size in its fragment.
`confirmUpload` checks the TUS offset and the stored object's size against the size the
upload was opened with: short is `incomplete`, a different size is `checksum_mismatch`, and
the upload stays open either way. An older object at the same key (a master being replaced)
does not count. The SHA-256 is not checked here: see below.

**Keys and buckets.** One private bucket per top-level folder; the object name is the whole
key. `mc-masters` (`masters/...`, 5 GiB, WAV, AIFF, FLAC), `mc-streams` (`streams/...`, no type
or size limit until session H picks the format), `mc-art` (`art/...`, 20 MiB, JPEG, PNG). No
storage policy gives clients anything in them. Keys are stored, never URLs.

**Signed reads.** `signRead` signs only `streams/{artist}/{release}/{track}/...` and the cover
key, never `masters/`. Each call makes a new link that lasts `MC_READ_TTL_SECONDS` (600). A
Supabase signed link is **not bound to the listener**: anyone who has the link can read the
file until it expires. `userId` cannot be put into it. Settled by K Marcus: keep short links
(600 s). A leak exposes one streaming copy, never a master, for at most that long, and plays
still count per signed-in account. When a link expires mid-track, the player asks
`getPlayback` again (Phase 1 player work).

**`readHead`.** A `Range: bytes=0-(n-1)` read with the secret key, at most 1 MiB, cut at the
limit even if the server ignores the range.

**Delete.** Walks every subfolder under a release prefix (`masters/{artist}/{release}/` or
deeper), deletes in batches of 1,000, and lists again to check nothing is left. Anything wider
is refused.

**Jobs.** `enqueue` calls `api_create_job(release, 'process_release')`, then starts a Fly
machine named `job-<id>` (so a second start is a no-op) with `MC_JOB_ID`, `auto_destroy` and
no restart. If Fly cannot be reached the row stays `queued`, enqueue still returns the id, and
the hourly sweep machine runs it. The worker claims a job with `api_job_started` (false means
someone else has it, and it stops), runs the processing step, and reports. A crash is reported
as a plain-words failure, never a stack.
**Stuck jobs.** A job may run for `MC_JOB_TIME_LIMIT_MINUTES` (default 240). Past that the
worker stops waiting and reports "Processing took too long and was stopped ...", and the hourly
sweep does the same for any job still `running` past the limit (its machine died). The release
moves to `failed` and the artist uploads again. A late report from the old machine changes
nothing, because a finished job is left alone. `reportResult` hands the result to session G's
job-result function, which is not wired yet (`worker/wiring.ts`).

**Processing.** Not decided (session H). The skeleton's step touches no file and reports a
plain failure ("Processing is not set up yet ...") so no release moves on without it.

**Schedules.** `runSqlFunctionAt` calls `api_schedule_set`, which records the run and
schedules a pg_cron job `mc_schedule:<name>` for that minute in UTC (rounded up; a past time
runs at the next minute). The job calls `api_schedule_fire`: if due, it runs the function once
with named arguments (cast to each argument's type from the catalog; values never in the SQL
text), deletes the row and removes the pg_cron job. A failed run keeps its row with the error.
The same name again replaces the run. A daily pg_cron job, `mc_schedule_sweep` at 00:30
UTC, runs every due run that was never fired, in case its own minute was missed (pg_cron has
no year, so a missed minute would otherwise wait a year). A failed run is not tried again. Only existing `public.api_*` functions. Session G
schedules `api_release_go_live` with `p_release_id`; it moves only `scheduled` to `live`, so a
run after a takedown is harmless.

**Server functions.** `edgeFunctions({ serve: Deno.serve }).handle(route, handler, deps)`.
The request reaches a function as `/<name>/v1/...`; the handler gets it with the path cut to
`/v1/...`. No match is the contract's 404 shape; a thrown error is a 500 with no details and is
logged with the request id. `src/edge.ts` builds the modules once per instance.

**Secrets and email.** Secrets are Edge Function secrets (environment variables), read by
name. Email goes through Resend's HTTP API: its free plan (3,000 a month, 100 a day) needs no
paid add-on, but does need a Resend account and a verified sending domain. Edge Functions
cannot open SMTP ports 25 or 587, and Supabase Auth's email only sends auth emails.

## Stand up, confirm, tear down

K Marcus runs these; they hold no secrets. Every setting comes from the shell or from two
secrets files kept outside the repository (`scripts/*.env.example` show what goes in them).

**Which project (settled).** A separate Supabase project for Phase 0, never the app's live
project: pushing `config.toml` replaces the project's auth settings. Create the project first
(on the Pro plan, see below); the stand-up loads the app's tables into it, then the Phase 0
SQL. It starts with no accounts, so create test artists and admins in it. Standing the slice up
on the live project is a later, separate step (Phase 1).

```bash
bash deploy/supabase/scripts/stand-up.sh
```

```bash
bash deploy/supabase/scripts/confirm.sh
```

```bash
bash deploy/supabase/scripts/tear-down.sh
```

The top of each script lists what it needs and does. The database step
(`scripts/apply-sql.sh`) applies, in **one transaction**: the app's SQL from
`milk-crate/supabase/` (only if the project has none yet, because session C's sync needs its
tables; read, never changed), then `db/migrations/`, `db/supabase/` (its `0006` last of C's) and
`sql/` here. The default grants on B's tables are never left open, and a failure changes
nothing.

**Plan and file size.** 5 GiB masters need the project's file size limit at 5 GiB
(`config.toml`, `[storage] file_size_limit`), and only the Pro plan or higher allows that: the
Free plan caps a file at 50 MB. `confirm.sh` reports the limit if it is lower.

**Tokens.** Token life stays at Supabase's default, 3600 seconds (`jwt_expiry`). A role change
shows after the token refreshes.

**Linter.** Supabase's linter flags session C's public views as "security definer view". That
is by design; the views are not granted to clients.

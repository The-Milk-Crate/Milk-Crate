You are session K of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to J4 are merged. Session H built the processing step (`worker/`): each track's master is checked, hashed and turned into one 320 kbps MP3. J4 made ffprobe and ffmpeg read a master only as its declared format, only from local files, with only `PATH` in their environment (security review M4). All of it is tested locally with ffmpeg 6.1, but **nothing has processed a real master on a real deployment yet**: the AWS smoke test's Fargate check starts a task for a job that does not exist and only checks that it exits cleanly, and Supabase has no smoke test. **You (session K) add a processing smoke check to both deployments.** You write and test the code; K Marcus runs it (the AWS one in the next sandbox run, the Supabase one after his stand-up).

Read these first, in this order:
1. `docs/phase0-handoff.md` (step 9, and the J4 entry in step 8a)
2. `docs/phase0-sessions.md` (shared rules, and the E, F and H sections)
3. `docs/phase0-runbooks/` (what K Marcus will do with your checks)
4. `worker/README.md`, `worker/src/words.ts`, `worker/test/helpers.ts` (how the tests make a release in `processing` through session B's functions)
5. `deploy/aws/scripts/smoke.ts` and `smoke.sh`, `deploy/aws/src/jobs.ts`, `deploy/aws/src/fargate.ts`, `.github/workflows/aws-sandbox.yml`, `deploy/aws/test/sandbox.test.ts`
6. `deploy/supabase/README.md`, `deploy/supabase/scripts/stand-up.sh` and `confirm.sh`, `deploy/supabase/src/jobs.ts`, `deploy/supabase/src/fly.ts`, `deploy/supabase/src/storage.ts`

### The check (the same on both platforms)

Four releases, each with one track, made with fresh random ids:

| Master | Declared | Expected end |
| --- | --- | --- |
| A short WAV (a few seconds, 44.1 kHz stereo) | `wav` | `awaiting_splits`, with `stream_key`, `duration_ms` and `sample_rate_hz` set, and an `audio/mpeg` object at `stream_key` |
| A short AIFF (48 kHz) | `aiff` | the same |
| A short FLAC (96 kHz mono) | `flac` | the same |
| The HLS playlist text below | `wav` | `failed`, with the reason from `worker/src/words.ts` `wrongFormat` for WAV: `Track 1, "<title>": this file is not a valid WAV. Export it again and upload it.` |

The playlist (its address is never meant to answer):

```
#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
http://127.0.0.1:9/seg.wav
#EXT-X-ENDLIST
```

For each release:
- **Make it as the tests do:** through session B's SQL functions (`api_start_upload`, then the master into storage at the returned key, then `api_confirm_upload` with the real SHA-256), so it reaches `processing`.
- **Store the master through the platform's real storage:** S3 on AWS, Supabase Storage on Supabase. Use the storage module where it has the call, or the SDK or API directly with the server's credentials.
- **Queue the job through the platform's real `Jobs` module (`enqueue`):** it creates the job row and starts the real worker (a Fargate task, or a Fly machine).
- **Use a separate artist for each release.** J1's limit allows at most 2 running processing jobs per artist, and the rest wait aside for the hourly sweep (`waiting` in `api_jobs`), which would stall the check.
- **Wait for the release to leave `processing`.** Poll `api_releases.state` with a time limit of about 20 minutes for all four, and print each job's time (from `api_jobs`' started and finished times, or wall time).
- **Print `ok - ...` or `FAIL - ...` per release,** in the smoke test's style, with the reason or stream key.

### Test audio: ffmpeg on the runner

**Decided by K Marcus:** make the WAV, AIFF and FLAC with ffmpeg at run time, as `worker/test/helpers.ts` does. No audio files are committed.
- **AWS:** add one step to `.github/workflows/aws-sandbox.yml`, before "Smoke test" and only when `MODE` is `run`, that installs ffmpeg (`sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg`). This is the only change allowed in `.github/workflows/`. Keep `deploy/aws/test/sandbox.test.ts` passing (no secrets, the same triggers and environment), and add a test that the install step is there and runs only in `run` mode.
- **Supabase:** the check runs on K Marcus's machine (WSL). It needs ffmpeg there: check for it at the start, with a plain message naming `sudo apt-get install ffmpeg` if it is missing.
- The runner's ffmpeg (Ubuntu 24.04's 6.1) makes the files, and the worker images' ffmpeg (Debian's 5.1) reads them. That is fine and intended: it is what a real artist's upload looks like to the worker.

### AWS (`deploy/aws/`)

- **Where:** add the check to `deploy/aws/scripts/smoke.ts`, after the Fargate check, and skip it with the Fargate check when `MC_SMOKE_SKIP_WORKER=1`.
- **Clean up** what it made, as the smoke test does, including the stream copies under `streams/`.
- **Update the docs:** the list at the top of `smoke.sh` and `deploy/aws/README.md`.

### Supabase (`deploy/supabase/`)

- **Where:** a new `scripts/smoke.sh` and `scripts/smoke.ts`, in the style of `confirm.sh` and `confirm.ts`. They read the same settings from the shell as `stand-up.sh` and `confirm.sh` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MC_DB_URL` with `PGPASSWORD`, the Fly settings), so K Marcus sets nothing new. Say in the header which settings each one reads.
- **Ask first:** before it changes anything, it asks for the project ref to be typed again, as `stand-up.sh` does.
- **Only this check:** the Supabase script runs just the processing check above. Don't port the rest of the AWS smoke test.
- **Clean up:** files in `mc-masters` and `mc-streams` under the test releases' prefixes. The Phase 0 project is kept, unlike the AWS sandbox, so cleanup matters more here. See "Ask before deciding" for database rows.
- **Update the docs:** `deploy/supabase/README.md` ("Stand up, confirm, tear down") and `docs/phase0-runbooks/supabase-stand-up.md` and its tracker (`.md`, `.xlsx`, `.csv`): one more step after the checks.

### Tests (offline, as today)

- **Each platform's suite covers the new code** with its existing fakes: the order of calls, a separate artist per release, the four expected ends, the time limit, and the cleanup also after a failure.
- **Real ffmpeg in a test is fine** (the worker tests use it). The tests make no network call beyond `127.0.0.1`, and use no real accounts or keys.
- **Run before you push,** from the repository root: `bash deploy/aws/test/run.sh`, `bash deploy/supabase/test/run.sh`, `bash worker/test/run.sh` and `bash tests/cross-cloud/run.sh`.

### Ask before deciding

- **Test rows in the database:** how to remove the releases, tracks, uploads and jobs the check makes, if session B's functions or triggers do not allow deleting them. Find out what is possible, and ask K Marcus before choosing. One option is to leave them on fresh random ids; the AWS sandbox is torn down anyway, but the Supabase project is kept.
- **Anything this brief does not cover.**

### From session D (CI)
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers`, `worker-processing`, `cross-cloud`.
- No new CI job is needed: the new tests go in the existing `aws-deploy` and `supabase-deploy` suites.

### Constraints
- **Only this check.** No change to the contract, the interfaces in `core/`, the database, the worker step (`worker/src/`) or the deployments' modules. If the check shows a module needs a change, stop and list it as an open point.
- **Workflows:** the one install step in `aws-sandbox.yml` is the only change in `.github/workflows/`.
- **No real runs:** don't start a sandbox run or touch a real Supabase project or Fly app. Write what K Marcus should run and what to expect.
- **No real projects, accounts, keys or network calls in the tests,** beyond `127.0.0.1` and the npm registry for installs. Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/k-processing-smoke`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `build.yml` or `pages.yml`. In `.github/workflows/`, only the step above.
- You get no keys, tokens or passwords. Never print or commit a secret.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description.
- Plain, short wording in comments and descriptions.

### Done when
- **AWS:** `smoke.ts` runs the four-release check after the Fargate check, and `aws-sandbox.yml` installs ffmpeg for it, with tests.
- **Supabase:** `scripts/smoke.sh` and `scripts/smoke.ts` run the same check, with tests and the docs above.
- **Checks pass:** every check listed passes locally.
- **Docs agree:** `docs/phase0-handoff.md` step 9 and `docs/phase0-runbooks/` say the processing check now exists and how to run it on each platform (the runbook rows "Not built (Pre 1)" become ready).
- **The pull request description lists:**
  - what changed, per platform;
  - what you ran and its result, with the ffmpeg version used;
  - exactly what K Marcus runs, and what to expect, on each platform;
  - open points and assumptions.

Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

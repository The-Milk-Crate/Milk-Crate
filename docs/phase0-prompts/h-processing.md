You are session H of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to F, G stage 1 (the shared handlers, The-Milk-Crate/Milk-Crate#31) and the wiring of G's handlers into E and F (The-Milk-Crate/Milk-Crate#32) are merged. The AWS side, with the handlers, has been deployed for real in a throwaway sandbox run. G stage 2 (the cross-cloud check) waits for you, because its scenario plays a track and that needs a streaming copy. This session was not in the original plan. It exists because one thing was left open on purpose: what the `processing` step does to a master.

Read these first, in this order:
1. `docs/phase0-handoff.md` (where things stand; step 5 is you)
2. `docs/phase0-sessions.md` (shared rules, and the sections for B, D, E, F, G and H)
3. `api/openapi.yaml` (the contract; find the release state table at the top: `uploading` → `processing` → `awaiting_splits` or `failed`)
4. `core/src/platform/` (the eight interfaces; read `jobs.ts` and `storage.ts` closely) and `core/src/handlers/`, especially `jobs.ts` (`makeApplyJobResult`, which applies a job result) and `uploads.ts` (what confirm checks and records)
5. `deploy/supabase/worker/` and `deploy/aws/worker/` (the two worker skeletons, already wired to G's functions), `deploy/aws/infra/stack.ts` (the Fargate task), and the open points in E's and F's pull requests (The-Milk-Crate/Milk-Crate#19, The-Milk-Crate/Milk-Crate#23)
6. `db/` (session B's tables, SQL functions and tests)

Your job: the processing work, as one shared piece that both workers call.

Today each worker (Fly Machines on Supabase, Fargate on AWS) picks up a `process_release` job, claims it and reports the result through G's `makeApplyJobResult`. The step in between is `processingNotBuilt`, which touches no file and reports "Processing is not set up yet, so this release cannot move on. Nothing is wrong with your files." You build what happens in between, once, for both.

### What the workers already do (don't redo it)
- **Two skeletons with the same rules and words.** `deploy/supabase/worker/run.ts` and `deploy/aws/worker/run.ts` each take a `ProcessRelease` step, `(job: { jobId, releaseId }) => Promise<JobResult>`. Each platform's `worker/main.ts` passes `processingNotBuilt` in; your function replaces it there, on both. A test in `deploy/aws/test/jobs.test.ts` checks the two skeletons keep the same words.
- **Around your step, already handled on both:**
  - Claiming the job with `api_job_started`. Don't call it a second time.
  - A time limit, `MC_JOB_TIME_LIMIT_MINUTES` (default 240; the Fargate task sets 240). Past it the worker reports "Processing took too long and was stopped…", and the hourly sweep does the same for a job left `running` by a dead machine. Check 4 hours is enough for your largest release and say so.
  - A crash in your step is reported in plain words, never as a stack.
  - Reporting the result through `makeApplyJobResult` (`worker/wiring.ts`), which moves the release to `awaiting_splits` or `failed`. Don't move states yourself.
  - The hourly sweep (`MC_WORKER_MODE=sweep`) runs G's `makeRequeueStuckReleases` and `makeRetryTakedownDeletes` first, then fails stuck jobs and runs queued ones with your step.
- **The images.** Each platform has its own `worker/Dockerfile` (Node 22, no ffmpeg), built from its own folder: Fly builds `deploy/supabase/` through `deploy/supabase/fly/fly.toml`; CDK builds `deploy/aws/` (`ecs.ContainerImage.fromAsset` in `deploy/aws/infra/stack.ts`). Neither build can reach outside its folder, so each `scripts/copy-core.sh` copies `core/src/` into `_core/` before the build (not committed). Your shared code reaches the images the same way (question 8, settled).
- **The machines.** The Fargate task has 1 vCPU and 2 GiB of memory. Fly machines are started per job by `Jobs.enqueue` (`deploy/supabase/src/fly.ts`). Say whether that is enough for ffmpeg on your largest release; if not, propose a size as an open point.

### Storage on each side
- **Supabase.** E's storage module talks to Supabase Storage over HTTP with the secret key (`deploy/supabase/src/storage.ts`); the Fly worker gets the service key from its secrets. Three private buckets, one per top folder: `mc-masters`, `mc-streams` (no type or size limit yet, waiting on your format) and `mc-art`. A stream read of a master is a plain `GET` of the object; for writing a streaming copy, Supabase advises TUS (6 MB chunks) above about 6 MB. The free Supabase project for Phase 0 caps files at 50 MiB (settled), so masters there are at most 50 MiB. Your opt-in 2 GB test still runs locally against fake storage.
- **AWS.** The worker builds its storage with `workerStorageFromEnv` (`deploy/aws/src/modules.ts`; bucket from `MC_BUCKET`). Its task role may so far only list and delete in the bucket and abort uploads (G's takedown retry). Reading `masters/*` and writing `streams/*` is yours to add, as the least it needs, in `deploy/aws/infra/stack.ts`. CloudFront never serves `masters/*`.
- **What confirm already checked.** G's `confirmUpload` checks the size (and CRC64NVME on S3) and records the client's SHA-256 in `api_tracks.master_sha256`. Neither store can check a whole-file SHA-256 itself, so the worker does it (question 4).

### Before you build anything: ask K Marcus
Don't guess these. Ask them in this session, one round, with the recommended answer first, and write the answers in your pull request.
1. Streaming copies: which format and bitrate? Recommended for Phase 0: one rendition, matching what the desktop app does today (320 kbps MP3), so listeners hear no change. Roadmap options (Opus or AAC at several bitrates) can wait.
2. Where derived files live (settled): streaming copies go under `streams/{artist}/{release}/{track}/`; you only choose the file names inside. Playback signs only there, and takedown deletes that prefix. Just confirm the file names.
3. What makes a master bad: recommended checks are the declared format matches the file, the whole file decodes, it is not empty or silent, and the duration and sample rate are readable. Failures become plain words for the artist (for example, "This file is not a valid FLAC. Export it again and upload it.").
4. The SHA-256 check (settled): the worker streams the master once, hashes it as it goes, and compares with `api_tracks.master_sha256`. A mismatch fails the release with plain words; the artist replaces the master (`failed` → `uploading`). Nothing to ask.
5. Sonic analysis (tempo, energy, brightness, dynamics) and smaller sizes of the cover art: in or out for Phase 0? Recommended: both out; the slice does not need them and fingerprinting is out of scope. Covers stay as the uploaded original.
6. The interface gap below.
7. The `mc-streams` bucket's limits on Supabase, once the format is chosen: the file type, and a size limit. Recommended: the format's MIME type, and no size limit beyond the project's.
8. Where the shared piece lives and how it reaches the images (settled by K Marcus, 20 November 2026): the code goes in a new top-level `worker/` folder. Each platform's `scripts/copy-core.sh` copies it into that platform's build folder next to `_core/` (not committed). Each platform keeps its own `worker/Dockerfile`, built as today, and both add ffmpeg the same way from the same pinned base image. Add a test that fails if the two Dockerfiles' base image or ffmpeg lines drift apart. Nothing to ask.

### Interface gap (needs K Marcus's approval)
`ObjectStorage` has only `readHead` (small ranged reads, for cover headers), no way for a worker to stream a master or write a streaming copy. Propose the smallest addition (for example `read(key)` returning a stream, and `put(key, stream)`). If K Marcus approves it, you may make exactly that addition in `core/src/platform/storage.ts` and the matching minimal implementations in `deploy/supabase/src/storage.ts` and `deploy/aws/src/storage.ts`, with tests next to theirs (`deploy/supabase/test/fake-storage.ts` is E's fake Supabase Storage, and `deploy/aws/test/storage.test.ts` F's; extend them for the new calls). G's handlers and test fakes implement `ObjectStorage` too: add the new methods to the fakes so `bash core/test/run.sh` still passes, and change no handler.

Beyond that, in `deploy/` you may only:
- pass your function to each worker in place of `processingNotBuilt` (`deploy/supabase/worker/main.ts`, `deploy/aws/worker/main.ts`), and remove `processingNotBuilt` from both `run.ts` files once nothing uses it (keep the words test passing);
- get your code and ffmpeg into each image as settled in question 8 (each `worker/Dockerfile`, `scripts/copy-core.sh`, `.gitignore` and `.dockerignore`, and `deploy/supabase/fly/fly.toml` if the build changes);
- give the Fargate task role read on `masters/*` and write on `streams/*`, and change its size only if K Marcus approves (`deploy/aws/infra/stack.ts`, with its infrastructure test);
- set the `mc-streams` limits K Marcus approves (`deploy/supabase/sql/0002_buckets.sql`).

Nothing else there. `bash deploy/supabase/test/run.sh` and `bash deploy/aws/test/run.sh` must still pass. If the interface addition is not approved, stop and write what is blocked.

### Build (after the answers)
- The processing piece: given a `process_release` job, for each track of the release:
  - Read the master as a stream (never load a 5 GiB file into memory), check it, hash it, compare the SHA-256 to `api_tracks.master_sha256`, and make the streaming copy.
  - Write the streaming copy under the agreed key. The master is never altered.
  - Record what is needed to play and show it in session B's track columns through `Database`, with parameters: `api_tracks.stream_key` (under `streams/{artist}/{release}/{track}/`; B refuses any other key), `duration_ms` and `sample_rate_hz`. Session G's `getPlayback` signs that key. On AWS `Database` runs over the RDS Data API, one statement per call, so keep each write one statement or use a transaction.
- The release result: success when every track passes; failure with one plain-words reason for the artist when any track fails. Return it from your step; the skeleton reports it.
- Safe to run twice: a retried job (or one the sweep runs again) gives the same result, never leaves half-written derived files behind (clean up on failure), and never touches the master.
- The thin entry point each platform's `worker/main.ts` calls, given that platform's modules. Ffmpeg in both images, as settled in question 8.
- If the data you need to record has no home in session B's tables, add an additive migration in `db/migrations/` (new numbered file, safe to run twice, existing tables unchanged) and say so in the pull request.

### Tests
- ffmpeg and ffprobe are installed in this environment. Generate small WAV, AIFF and FLAC test files with ffmpeg at test time; don't commit audio files.
- Cover: each of the three formats, a file whose format doesn't match what was declared, a truncated file, an empty file, a wrong SHA-256, a retried job, and cleanup after a failure.
- One run through each platform's worker skeleton (`runOneJob` with your step and that platform's storage fake), ending with the release in `awaiting_splits` or `failed`.
- One opt-in slow test (not run by default): generate a 2 GB WAV, stream it through, and check memory use stays small.
- Use fake storage and a local PostgreSQL 16 (session B's throwaway approach; `core/test/run.sh` shows it). There is no Docker daemon here, so write the image changes but say you could not build them.
- Keep tests free of anything specific to one machine, because CI runs them. Node 22.18 or newer runs the TypeScript directly, as the other packages do.

### From session D (merged; CI)
- Every pull request into `milk-crate-backend-poc` runs "Phase 0 checks" (`.github/workflows/phase0-checks.yml`). Required to merge: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy` and `aws-deploy` (and `core-handlers` once K Marcus adds it).
- Run them yourself before you push. From the repository root: `bash db/test/run.sh`, `bash core/test/run.sh`, `bash deploy/supabase/test/run.sh` and `bash deploy/aws/test/run.sh`. From `milk-crate/`: `npm ci`, `npm run api:lint`, `npm run api:client` (then `git diff --exit-code src/lib/api/schema.d.ts` must be empty), `npm run api:core`, `npx tsc --noEmit` and `npm test`.
- `client-fresh` fails if `milk-crate/src/lib/api/schema.d.ts` no longer matches `api/openapi.yaml`. The contract is fixed, so this matters only if K Marcus approves a contract change.
- A change to `core/src/` starts `types`, `core-handlers`, `supabase-deploy` and `aws-deploy`; a change under `deploy/supabase/` or `deploy/aws/` starts that platform's job. A change only under `worker/` starts nothing until you add a job for it. A new file in `db/migrations/` starts `database`.
- You may add one job to `.github/workflows/phase0-checks.yml` for your tests, and change nothing else in `.github/workflows/` (settled by K Marcus; see "Adding a test job" under "D: CI" in `docs/phase0-sessions.md`). Give your tests one documented command that runs from a clean checkout, with no keys and no network beyond package installs. Add one output to the `changes` job with the paths that should start your job (at least `worker/`, `core/src/platform/` and both `deploy/*/worker/`), and copy the pattern of `core-handlers` (the pinned action SHAs, `runs-on: ubuntu-24.04`, a timeout, no secrets, no deploy steps); install ffmpeg in the job with `apt-get`. Name the job in your pull request so K Marcus can make it required.

### Constraints
- No platform SDK imports and no new runtime dependencies in `core/`. The shared worker code lives in `worker/` (question 8) and may use dependencies there; keep them few.
- Don't change the contract, the other interfaces, the handlers, the read rules, CI beyond your one job, or the app's existing tables, policies, screens or Supabase calls.
- No real accounts, keys or network calls. Don't start a sandbox run; K Marcus does that after merging.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/h-processing`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` beyond adding your one test job (session D owns CI). Never edit `build.yml`, `pages.yml` or `aws-sandbox.yml`: `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.
- When done, update `docs/phase0-handoff.md` (what H left, and that G2 is next) in the same pull request.

### Done when
- Every track of a release is checked, hashed and turned into a streaming copy by one shared piece, and the release reaches `awaiting_splits` or `failed` through the existing job result path, on both platforms' workers.
- The tests pass, including the failure cases and cleanup; `core/` and `milk-crate/` type-check, `cd milk-crate && npm test` passes, and `bash core/test/run.sh`, `bash deploy/supabase/test/run.sh` and `bash deploy/aws/test/run.sh` still pass.
- Both images are ready to carry ffmpeg and your code, and the Fargate task role has the S3 access processing needs and no more.
- The pull request description lists: K Marcus's answers to the open questions (1, 3, 5, 6 and 7) and the file names chosen under `streams/`, what you built, what you ran and its result, what you could not run (at least the image builds and anything on real Supabase or AWS), every change made to another session's folders, the name of your CI job, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

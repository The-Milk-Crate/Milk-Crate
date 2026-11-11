You are session H of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to G (stage 1) are merged. This session was not in the original plan. It exists because one thing was left open on purpose: what the `processing` step does to a master.

Read these first, in this order:
1. `docs/phase0-sessions.md` (shared rules, and the sections for B, E, F and G)
2. `api/openapi.yaml` (the contract; find the release state table at the top: `uploading` → `processing` → `awaiting_splits` or `failed`)
3. `core/src/platform/` (the eight interfaces; read `jobs.ts` and `storage.ts` closely) and session G's handlers, especially the function that applies a job result
4. `deploy/supabase/` and `deploy/aws/` (the job queues and worker skeletons that sessions E and F built, and the open points in their pull requests)
5. `db/` (session B's tables, SQL functions and tests)

Your job: the processing work, as one shared piece that both workers call.

Today the worker skeletons (Fly Machines on Supabase, Fargate on AWS) pick up a `process_release` job and report success or a failure in plain words. Nothing yet happens in between. You build what happens in between. Fly Machines and Fargate both run containers, so build one worker and one container image that run on both, not two.

### Before you build anything: ask K Marcus
Don't guess these. Ask them in this session, one round, with the recommended answer first, and write the answers in your pull request.
1. Streaming copies: which format and bitrate? Recommended for Phase 0: one rendition, matching what the desktop app does today (320 kbps MP3), so listeners hear no change. Roadmap options (Opus or AAC at several bitrates) can wait.
2. Where derived files live (settled): streaming copies go under `streams/{artist}/{release}/{track}/`; you only choose the file names inside. Playback signs only there, and takedown deletes that prefix. Just confirm the file names.
3. What makes a master bad: recommended checks are the declared format matches the file, the whole file decodes, it is not empty or silent, and the duration and sample rate are readable. Failures become plain words for the artist (for example, "This file is not a valid FLAC. Export it again and upload it.").
4. The SHA-256 check (settled): the worker streams the master once, hashes it as it goes, and compares with the SHA-256 recorded at confirm. A mismatch fails the release with plain words; the artist replaces the master (`failed` → `uploading`). Nothing to ask.
5. Sonic analysis (tempo, energy, brightness, dynamics) and smaller sizes of the cover art: in or out for Phase 0? Recommended: both out; the slice does not need them and fingerprinting is out of scope. Covers stay as the uploaded original.
6. The interface gap below.

### Interface gap (needs K Marcus's approval)
`ObjectStorage` has only `readHead` (small ranged reads, for cover headers), no way for a worker to stream a master or write a streaming copy. Propose the smallest addition (for example `read(key)` returning a stream, and `put(key, stream)`). If K Marcus approves it, you may make exactly that addition in `core/src/platform/storage.ts` and the matching minimal implementations in the storage modules of `deploy/supabase/` and `deploy/aws/`, and nothing else in those folders. If not approved, stop and write what is blocked.

### Build (after the answers)
- The processing piece: given a `process_release` job, for each track of the release:
  - Read the master as a stream (never load a 5 GiB file into memory), check it, hash it, compare the SHA-256 to what the client sent, and make the streaming copy.
  - Write the streaming copy under the agreed key. The master is never altered.
  - Record what is needed to play and show it in session B's track columns through `Database`, with parameters: `api_tracks.stream_key` (under `streams/{artist}/{release}/{track}/`; B refuses any other key), `duration_ms` and `sample_rate_hz`. Session G's `getPlayback` signs that key. The client's SHA-256 to compare against is `api_tracks.master_sha256`.
  - When the worker picks a job up, it calls `api_job_started(job)`.
- The release result: success when every track passes; failure with one plain-words reason for the artist when any track fails. Report it through the job result path so the release moves to `awaiting_splits` or `failed` (session G's function applies it; don't move states yourself).
- Safe to run twice: a retried job gives the same result, never leaves half-written derived files behind (clean up on failure), and never touches the master.
- The container: one `Dockerfile` for the worker (Node 22 plus ffmpeg), and the thin entry point each platform's worker skeleton calls. Don't change the platforms' worker skeletons beyond calling your function.
- If the data you need to record has no home in session B's tables, add an additive migration in `db/migrations/` (new numbered file, safe to run twice, existing tables unchanged) and say so in the pull request.

### Tests
- ffmpeg and ffprobe are installed in this environment. Generate small WAV, AIFF and FLAC test files with ffmpeg at test time; don't commit audio files.
- Cover: each of the three formats, a file whose format doesn't match what was declared, a truncated file, an empty file, a wrong SHA-256, a retried job, and cleanup after a failure.
- One opt-in slow test (not run by default): generate a 2 GB WAV, stream it through, and check memory use stays small.
- Use fake storage and a local PostgreSQL 16 (session B's throwaway approach). There is no Docker daemon here, so write the `Dockerfile` but say you could not build it.
- Keep tests free of anything specific to one machine, because session D runs them in CI.

### Constraints
- No platform SDK imports and no new runtime dependencies in `core/`. The worker code lives in a new top-level folder, `worker/`, and may use dependencies there.
- Don't change the contract, the other interfaces, the handlers, the read rules, CI, or the app's existing tables, policies, screens or Supabase calls.
- No real accounts, keys or network calls.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/h-processing`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- You get no keys, tokens or passwords. Never print or commit a secret.
- The contract is fixed. If it needs to change, don't edit it; write the change and the reason in your pull request as an open point for K Marcus.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the code.
- Plain, short wording in comments and descriptions.

### Done when
- Every track of a release is checked, hashed and turned into a streaming copy by one shared piece, and the release result reaches `awaiting_splits` or `failed` through the existing job result path.
- The tests pass, including the failure cases and cleanup; `core/` and `milk-crate/` type-check and `cd milk-crate && npm test` still passes.
- The `Dockerfile` and entry point are ready for both platforms' workers to use.
- The pull request description lists: K Marcus's answers to the open questions (1, 3, 5 and 6) and the file names chosen under `streams/`, what you built, what you ran and its result, what you could not run (at least the image build), any change made to another session's folders, the open points for K Marcus, and anything you assumed.
Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

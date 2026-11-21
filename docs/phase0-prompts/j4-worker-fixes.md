You are session J4 of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: Supabase (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and AWS (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Sessions A to I are merged. Session I's security review is in `docs/security/review-phase0.md`, and K Marcus decided a fix for every finding (the table "Decided by K Marcus" near the end). Four sessions make the fixes, by owner: J1 (database, handlers, email templates), J2 (Supabase), J3 (AWS) and **J4 (you): session H's shared worker step, `worker/`**. They can run at the same time. Don't change files the others own.

Read these first, in this order:
1. `docs/security/review-phase0.md` (finding M4, and the decision table)
2. `docs/phase0-sessions.md` (shared rules, and H's section)
3. `worker/README.md`, `worker/src/media.ts`, `worker/src/process.ts`, `worker/test/`

### Fix: run ffprobe and ffmpeg on untrusted masters safely (M4)

**The problem.** `probe` and `transcode` in `worker/src/media.ts` run `ffprobe ... <file>` and `ffmpeg -i <file>` with no input format and no protocol limit, so ffmpeg guesses the format from the content. Some formats (playlists, concat files) make it open other files or URLs. The processes inherit the worker's environment, which holds the database owner's password and the Supabase service key (Fly), or the task role's credentials address (Fargate).

**Decided by K Marcus:**
- **Input format:** pass `-f` before the input on both commands, from the declared format: `wav` → `-f wav`, `aiff` → `-f aiff`, `flac` → `-f flac`. A file that is not that format then fails as `wrong_format` (probe) as today. `transcode` needs the declared format as a new argument; `process.ts` has it (`track.master_format`).
- **Protocols:** pass `-protocol_whitelist file` on both commands, before the input.
- **Environment:** spawn both with an environment holding only `PATH` (from the worker's own `process.env.PATH`), nothing else. Check ffmpeg runs that way in the tests (locale or `HOME` warnings are fine; failures are not).
- Not now: a separate user or no network for ffmpeg (later).

**Tests** (`worker/test/`, real ffmpeg as today):
- an HLS playlist and an `ffconcat` file, each pointing at a local HTTP server the test starts on `127.0.0.1`, saved as a master declared `wav`: the job fails with the wrong-format words, and the server sees no request;
- a real WAV, AIFF and FLAC still process as before;
- the spawned processes get only `PATH` (for example a fake `ffprobe` on `PATH` in a temp folder that writes its environment to a file).

Keep both platforms' Dockerfiles as they are (a test checks they match). The handoff's next sandbox run already processes a WAV, AIFF and FLAC on the real Fargate image (Debian's ffmpeg 5.1); say in the pull request that it should also try one playlist file.

### From session D (CI)
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`, `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers`, `worker-processing`, `cross-cloud`.
- Run before you push: `bash worker/test/run.sh`, `bash deploy/supabase/test/run.sh`, `bash deploy/aws/test/run.sh` and `bash tests/cross-cloud/run.sh` from the repository root (both workers copy `worker/src/`).
- No new CI job is needed. Don't change `.github/workflows/`.

### Constraints
- Only this fix. No change to the contract, the interfaces, the database or the deployments' modules.
- No real projects, accounts, keys or network calls beyond `127.0.0.1` in the tests. Say what you could not run.

### Rules (all apply)
- Work on a new branch from `milk-crate-backend-poc` named `phase0/j4-worker-fixes`. Push only that branch. Open one draft pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- Don't touch `.github/workflows/`, `build.yml` or `pages.yml`.
- You get no keys, tokens or passwords. Never print or commit a secret.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description.
- Plain, short wording in comments and descriptions.

### Done when
- Both commands use `-f`, `-protocol_whitelist file` and a `PATH`-only environment, with the tests above, and every check listed passes locally.
- The pull request description lists what changed, what you ran and its result (with the ffmpeg version used), what the next sandbox run should try, open points and assumptions.

Then stop. K Marcus reviews it, and a separate review agent also reviews the pull request.

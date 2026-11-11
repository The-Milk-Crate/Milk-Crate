You are session A of Phase 0 of Milk Crate, a music streaming service and marketplace for artists. The repository holds a desktop app (Tauri 2, React 19, TypeScript, Vite) in `milk-crate/`. Phase 0 is a backend proof of concept that runs on two deployments from one codebase: **Supabase** (Auth, Postgres, Storage, Edge Functions on Deno, a worker on Fly Machines) and **AWS** (Cognito, Aurora PostgreSQL through the RDS Data API, S3, API Gateway and Lambda on Node 22, a worker on Fargate). Anything that runs on one must run on the other.

Your job: write the API contract and the platform interfaces that every later session builds against. **Write no implementation.** Sessions B–G implement it.

### Rules (all of them apply)
- Work on a new branch made from `milk-crate-backend-poc`, named `phase0/a-api-contract`. Push only that branch. Open one pull request into `milk-crate-backend-poc`.
- Never push to `main` or `milk-crate-backend-poc`, never push or create tags, never merge any pull request (including your own), never change repository settings, rulesets, environments or secrets.
- You get no keys, tokens or passwords, and you need none. Never print or commit a secret.
- Don't change the desktop app's screens or its existing calls to Supabase. The app keeps calling Supabase directly for everything outside this slice until Phase 1.
- Don't touch `.github/workflows/` (session D owns CI). `build.yml` publishes a desktop release on every push to `main`, so nothing here may need a change to it.
- Ask before deciding anything this brief doesn't cover. List open points in the pull request description, not as guesses in the contract.
- Plain, short wording in comments and descriptions.

### Scope: the first slice only — release publishing and plays
Endpoints (names and paths are yours to propose; keep them consistent):
1. Create a draft release.
2. Start a master upload for a track (returns an upload session; see "Uploads").
3. Confirm an upload (client sends its SHA-256; S3 uploads also carry CRC64NVME).
4. Add rights and splits (parties and percentage shares for the recording and the composition; each invitee's state: invited, accepted, declined).
5. Submit for review.
6. Review decision (approve, or needs changes with a reason) — reviewer account types only.
7. Publish (server moves the release to scheduled or live by its release date).
8. Read a release (the artist's own view, and the public view, which hides `owner_id` and anything not live).
9. Get playback for a track for the signed-in listener: an entitlement check that answers **how** to play (Supabase: a signed link unique to that listener; AWS: CloudFront signed cookies plus the stream address), not a fixed URL format.
10. Record play events: batched `start` / `progress` (every 15–30 s) / `end`, each batch with an idempotency key; the same batch sent twice counts once. The server decides what is a qualified stream (30 s or more); the client never sends counts.
11. Takedown (reviewer/admin only): the server removes access and files and writes an audit row.

Out of scope: sign-in and sign-up (each deployment's identity module handles them), the other ~131 server calls, payments, payouts, scenes, fingerprinting.

### Release states (an enum in the contract)
`draft → uploading → processing → awaiting_splits → awaiting_review → scheduled → live`, plus `needs_changes` (back to the artist with a reason), `failed` (a processing error in plain words) and `taken_down`. Only the server moves a release between states. Session C's read rules hide everything that isn't `live` from listeners. Document which endpoint causes which move.

### Account types (one claim, both deployments)
End user (listener), Artist (manages only their own profile and releases), Third party, Administrator, Internal non-admin, Internal accounting. Supabase puts it in the token with a custom access token hook; AWS uses Cognito groups. Define the claim name and values once, and which account types may call each endpoint.

### Uploads
Masters are WAV, AIFF or FLAC, up to at least 2 GB in tests. The upload session must allow both resumable uploads on Supabase (TUS) and S3 presigned multipart on AWS, so the response is a tagged union by method, not one shape. An interrupted upload picks up where it stopped. Store keys, never public URLs. Masters live at `masters/{artist}/{release}/{track}/original` and are never altered.

### Platform interfaces (TypeScript types only, no implementation)
Seven small interfaces the shared core calls; each deployment implements each one fully later:
| Module | What the core asks of it |
|---|---|
| Identity | who is calling, and their account type |
| Object storage | start an upload, confirm it, sign a read, delete |
| Jobs | queue a job, report its result |
| Schedules | run this SQL function at this time |
| Server functions | handle this request |
| Secrets and email | get a secret by name; send this template |
| Infrastructure | stand up, confirm, tear down |
Keep each interface as small as the slice needs. Handlers use web-standard `Request`/`Response` and take their dependencies (these modules) as arguments, so one handler runs on Edge Functions (Deno) and Lambda (Node). No platform SDK imports in the shared core.

### Where things go
- Contract: `api/openapi.yaml` (OpenAPI 3.1) at the repository root.
- Platform interfaces and shared types: `core/src/platform/` (a sibling package to `milk-crate/`, no runtime dependencies).
- Generated typed client: `milk-crate/src/lib/api/` — generated from the contract, with a script to regenerate it; not yet called by any screen.
- Add an npm script to lint the contract (e.g. Redocly or Spectral run through npx; say which and why in the PR) and one to regenerate the client.

### Done when
- The contract lints clean with the chosen linter.
- Every endpoint has request, response and error shapes (one shared error shape), the account types allowed, and the state moves it causes.
- The interfaces type-check (`tsc --noEmit`) and the existing desktop tests still pass (`cd milk-crate && npm test`).
- The pull request description lists: the endpoints, the open points you need K Marcus to decide, and anything you assumed.
Then stop. K Marcus reviews the whole contract before any other session starts; a separate review agent also reviews the pull request.

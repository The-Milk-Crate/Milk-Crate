# Phase 0: where things stand (handoff)

For K Marcus and the next session. Last updated 20 November 2026, after five sandbox runs, session G1, its wiring and session H. Next: session G2.
`docs/phase0-sessions.md` holds the rules and each session's brief; this file holds only the
current state and the next steps. Update it when a step is done.

## Done

- Sessions A to F are merged into `milk-crate-backend-poc`, with D's CI follow-up for E.
- F: the AWS deployment (`deploy/aws/`, #23) and a throwaway sandbox run from GitHub
  (`.github/workflows/aws-sandbox.yml`, #24).
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`,
  `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`, `core-handlers` and
  `worker-processing` (both added 20 November).
- Sandbox runs 1 to 3 (13 November): the first time the AWS code ran against real AWS. Run 1
  could not sign in; run 2 and run 3 passed 11 checks and skipped SES (no email domain). Three
  problems found and fixed, none in the main AWS code until the last:
  - Sign-in (#27): this repository uses GitHub's immutable OIDC subject
    (`gh api repos/The-Milk-Crate/Milk-Crate/actions/oidc/customization/sub` shows
    `use_immutable_subject: true`), so the token's `sub` is
    `repo:The-Milk-Crate@353489113/Milk-Crate@1421168430:environment:aws-sandbox`. The role
    template now trusts that. The role in `milkcrate-dev` was redeployed by hand.
  - Role permission (#27): the sandbox role could pass roles only to `ecs-tasks.amazonaws.com`;
    creating a schedule also passes one to `scheduler.amazonaws.com`. Added. Redeployed by hand.
  - Real bug (#28): Scheduler's target `Input` must name the Data API fields in PascalCase
    (`Name`, `Value`, `StringValue`), not camelCase. Fixed in `deploy/aws/src/schedules.ts`.
    The test fake had accepted both; it now converts as Scheduler does, so this class of mistake
    fails in the tests.
  - Now checked on real AWS and `ok`: the Data API (parameter and value shapes, error mapping,
    failed transactions), S3 uploads (part checksums, resume, CRC64NVME confirm), `readHead`,
    CloudFront signed cookies (streaming copy served, master never served), the Cognito claim
    through the sync, and one Fargate task per job id.
- Sandbox run 4 (20 November, commit `d0fd318`,
  https://github.com/The-Milk-Crate/Milk-Crate/actions/runs/43512182763): every check `ok`
  except SES (skipped: no `MC_SMOKE_EMAIL_TO`). The Scheduler fix (#28) works on real AWS: a
  go-live run fired through the Data API and the schedule deleted itself, and a failing run
  reached the dead-letter queue carrying its SQL error (`not_found: no such release; SQLState:
  MC404`). Tear-down finished (`MilkCratePhase0: destroyed`, CloudFront key secret deleted), so
  nothing was left in the account. Smoke test about 3 minutes, tear-down about 22. The AWS side
  is clean except SES.
- Sandbox run 5 (20 November, commit `7925cd5`, after G1 and its wiring,
  https://github.com/The-Milk-Crate/Milk-Crate/actions/runs/44807547866): the first deploy
  of the shared handlers on AWS. The stand-up copied `core/src/` into `_core/`, CDK bundled
  all 21 operation Lambdas and built the worker image with the copy; the stack created all 21
  Lambdas and 21 API Gateway routes and the worker role's S3 delete rights, with no failure or
  rollback (about 9 minutes). Every smoke check `ok` as in run 4, SES skipped; torn down
  cleanly (`MilkCratePhase0: destroyed`). The smoke test does not call the API, so this shows
  the API deploys, not that it answers (G2's job). `confirm.sh`'s two SES problems (domain not
  verified, SES sandbox) are expected while there is no email domain.
- G1, the shared handlers (#31): every operation in `core/src/handlers/`, exported from
  `core/src/handlers/index.ts` (the 21 handlers, `operations` with each route, `router`), plus
  `makeApplyJobResult` for the workers and two sweep functions, `makeRequeueStuckReleases` and
  `makeRetryTakedownDeletes`. Tests: `bash core/test/run.sh` (also on Deno with `DENO=...`),
  CI job `core-handlers`. Decided by K Marcus on 20 November (details in #31):
  - covers at least 1400 pixels a side;
  - invite limits as built: 10 wrong codes per party an hour (B's), 5 sends per party a day;
  - the owner's own share is the party with no email (no `isOwner` field until Phase 1);
  - `respondToSplit` returns only the invitee's own party (a contract wording fix for later);
  - `putRights` needs both sides at 100;
  - `createRelease` and `recordPlays` stay without a rate limit in Phase 0 (for session I to
    flag, and a later session to add on both clouds).
- Rule change: each session adds one CI job for its own tests in its own pull request ("D: CI",
  "Adding a test job"). No more session D follow-ups.

## Next steps, in order

1. Done (K Marcus, November 2026): the one-time setup of the sandbox run in the `milkcrate-dev`
   AWS account (`689445872429`, `us-east-1`).
   - CDK bootstrapped; stack `MilkCrateGitHubSandbox` created (role `MilkCrateSandboxDeploy`,
     with a new GitHub identity provider).
   - GitHub environment `aws-sandbox`: required reviewer K Marcus; deployment branches
     `aws-sandbox-run` and `aws-sandbox-teardown`; variables `AWS_ROLE_ARN`, `MC_AWS_ACCOUNT`,
     `MC_AWS_REGION` and `MC_EMAIL_DOMAIN` (`example.com` for now: there is no email domain yet).
   - Notes from doing it, for the next person on a Windows drive under WSL: use a Node 22 build
     with TypeScript support (`nvm install 22`; the distro `/usr/bin/node` had none, and `cdk`
     runs `node infra/app.ts`); `cdk bootstrap` runs the app, so it needs `MC_EMAIL_DOMAIN`,
     `MC_EMAIL_FROM` and a PEM file in `MC_CLOUDFRONT_PUBLIC_KEY_FILE` (throwaway values are fine);
     set `git config core.autocrlf input` or every file shows as modified.

2. Done (20 November 2026): run 4 of the sandbox, checking the Scheduler fix (#28). All
   checks `ok` except SES; torn down cleanly. See "Done" above.

3. Done (20 November 2026): session G1, the shared handlers (#31). See "Done" above.
   `core-handlers` is a required check on `milk-crate-backend-poc` (added 20 November).

4. Done (20 November 2026): G1 wired into E and F (#32).
   - Supabase: one Edge Function, `api`, serving G's router (decided by K Marcus: one address
     for the app, `.../functions/v1/api/v1/...`).
   - AWS: one Lambda and one API route per operation (`deploy/aws/functions/`, `routes.json`).
   - Both workers: `makeApplyJobResult` for job results, and the hourly sweep runs
     `makeRequeueStuckReleases` and `makeRetryTakedownDeletes` first. The Fargate task role
     may now list and delete in the bucket, and gets `MC_BUCKET`.
   - The worker images and the Edge Function get a copy of `core/src/` (`scripts/copy-core.sh`
     in each package, run by the stand-ups and the tests; not committed), because their build
     contexts cannot reach `core/`.
   - AWS deployed for real in sandbox run 5 (see "Done"). Not yet run for real: the Supabase
     side (`supabase functions deploy api` with the copy, and the Fly image), which needs
     K Marcus's stand-up; the hourly sweeps' new part; and any call to the API.

5. Done (20 November 2026, pull request open): session H, processing. One shared step in
   `worker/` (see `worker/README.md`), passed to both workers' skeletons in place of
   `processingNotBuilt`. Per track: stream the master once and check its SHA-256, check the
   format with ffprobe, decode it all the way through into one 320 kbps MP3 at
   `streams/{artist}/{release}/{track}/mp3-320.mp3`, then record `stream_key`, `duration_ms` and
   `sample_rate_hz` on every track together. Built to K Marcus's eight decisions in the H prompt.
   - `ObjectStorage` gained `read` and `put` (decision 6), on both storage modules.
   - Both worker images: the same pinned base image (`node:22.23.5-bookworm-slim` by digest)
     plus ffmpeg, and a copy of `worker/src/` in `_worker/` (`scripts/copy-core.sh`).
   - The Fargate task role may now read `masters/*` and write `streams/*` (nothing more).
   - `mc-streams` on Supabase takes `audio/mpeg` only (decision 7).
   - Tests: `bash worker/test/run.sh` (CI job `worker-processing`, a required check
     since 20 November). Slow test: `MC_SLOW=1 bash worker/test/run.sh`.
   - Not run for real yet: neither image was built (no Docker here), and nothing ran on real
     Supabase, Fly or AWS. The next sandbox run builds the Fargate image with ffmpeg.
   - Decided by K Marcus on 20 November, from the pull request's open points:
     - keep the 4-hour job limit. A cap on a release's total master size, or one job per
       track, waits until after Phase 0 and real Fargate timings;
     - keep the machine sizes (Fargate 1 vCPU / 2 GiB, Fly 2 shared CPUs / 2 GiB);
     - `processingNotBuilt` removed from both skeletons, with E's and F's tests changed to a
       test-only step;
     - Debian's ffmpeg 5.1 in the images (6.1 in the tests): check it in the next sandbox run
       (see step 8);
     - keep it strict: any error ffmpeg logs fails the track;
     - copies left by a worker that dies mid-job are accepted for Phase 0. They are never
       recorded. The next successful job overwrites them, or a takedown deletes them;
     - the deployment READMEs now describe the real step.

6. Next: session G2, the cross-cloud check (its scenario plays a track; the streaming copy now
   exists once H is merged). Its real-deployment script can use a sandbox run kept with
   `MC_SANDBOX_KEEP=true`.

7. Session I, the security review. Include the missing rate limits on `createRelease` and
   `recordPlays` (decided: not in Phase 0).

8. A larger sandbox run after I, with the same workflow. Add a smoke check to it that processes
   one small WAV, AIFF and FLAC on the real Fargate image, which has Debian's ffmpeg 5.1 (the
   tests use 6.1; decided by K Marcus with session H). Note the real time per job, for the
   4-hour limit.

## Still open

- SES: DKIM records for the sending domain and production access, before email reaches
  unverified addresses. There is no email domain yet; `MC_EMAIL_DOMAIN` is `example.com`. The
  smoke test's email check needs `MC_SMOKE_EMAIL_TO`, which the workflow does not pass yet.
- Not yet checked against real AWS: SES sending, the Fargate worker doing real processing
  (session H's step, with ffmpeg in the image; the next sandbox run builds it), and a call to the handlers behind API Gateway and Lambda (deployed in run 5;
  G2 calls them).
- Two handler limits noted in #31: a failed email is only logged (the owner can resend an
  invitation), and two sweeps at the same moment could queue an extra, harmless job.
- The owner and repository ids are written into `deploy/aws/infra/github-oidc.json`. They
  survive a rename; a transfer or a new repository needs new ones.

## Working notes for the next session

- K Marcus works on Windows with WSL: the checkout is `/mnt/e/GitHub/Milk-Crate`, with
  `core.autocrlf input`, nvm Node 22, AWS profile `milkcrate-dev` (SSO administrator; run
  `aws sso login --profile milkcrate-dev` when it expires; export `AWS_PROFILE=milkcrate-dev`).
- Give K Marcus one step at a time, with the exact command or click and what to expect. Grouped
  steps were confusing. Say what is expected before they run something in AWS or GitHub.
- A Claude session here can create branches and open draft pull requests, but cannot delete
  branches (the connection refuses), cannot read GitHub's OIDC or org settings, and holds no AWS
  keys. K Marcus deletes `aws-sandbox-run` in the GitHub branch list, and merges pull requests.
- Restarting a sandbox run: K Marcus deletes `aws-sandbox-run`, the session creates it again
  from `milk-crate-backend-poc`, K Marcus approves under "Review deployments".
- Changing the sandbox role (`deploy/aws/infra/github-oidc.json`) takes two steps: merge the
  change, and run the `aws cloudformation deploy` command for stack `MilkCrateGitHubSandbox`
  from `deploy/aws/README.md` by hand. The deployed role changes only when K Marcus does that.

# Phase 0: where things stand (handoff)

For K Marcus and the next session. Last updated at the end of session F (November 2026).
`docs/phase0-sessions.md` holds the rules and each session's brief; this file holds only the
current state and the next steps. Update it when a step is done.

## Done

- Sessions A to F are merged into `milk-crate-backend-poc`, with D's CI follow-up for E.
- F: the AWS deployment (`deploy/aws/`, #23) and a throwaway sandbox run from GitHub
  (`.github/workflows/aws-sandbox.yml`, #24).
- Required checks on `milk-crate-backend-poc`: `changes`, `contract`, `client-fresh`, `types`,
  `desktop-tests`, `database`, `supabase-deploy`, `aws-deploy`.
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

2. First sandbox run: create the branch `aws-sandbox-run` from `milk-crate-backend-poc`, then in
   Actions → "AWS sandbox run" → "Review deployments", approve (check the commit is the one you
   expect). Read the smoke test's `ok -` / `FAIL -` lines (about an hour; SES unverified is
   expected). Delete the branch. This is the first time any of the AWS code runs against real
   AWS. If a check fails, fix it in `deploy/aws/` before G1.

3. Session G1, the shared handlers: `docs/phase0-prompts/g1-core.md`. See "From E and F" in
   G's section of `docs/phase0-sessions.md` (the job-result path, entry points, error mapping,
   the `s3_multipart` confirm check).

4. Session H, processing: `docs/phase0-prompts/h-processing.md`. See "From F" in H's section
   (the worker's S3 access).

5. Session G2, the cross-cloud check, best after H (its scenario plays a track, which needs a
   streaming copy). Its real-deployment script can use a sandbox run kept with
   `MC_SANDBOX_KEEP=true`.

6. Session I, the security review.

7. A larger sandbox run after I, with the same workflow.

## Still open

- SES: DKIM records for the sending domain and production access, before email reaches
  unverified addresses. The smoke test's email check needs `MC_SMOKE_EMAIL_TO`, which the
  workflow does not pass yet.
- Not yet checked against real AWS (the first sandbox run checks them): the Data API's error
  and timestamp formats, S3's part checksum rules, CloudFront cookies, Scheduler calling the
  Data API, one Fargate task per job id, SES sending.

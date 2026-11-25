# Sandbox run (step 9): step by step

Written 25 November 2026. Tracker: `sandbox-run.xlsx` (or `.csv`) in this folder.

Step 9 is the larger AWS sandbox run in `milkcrate-dev`: stand up, smoke test, tear down, started
from GitHub and approved by you. Some of its checks are not built yet. Today's smoke test
processes no audio: its Fargate check starts a task for a job that does not exist and only checks
that the task exits cleanly. So the run needs one session's work first.

## Before you start

The checks fall into three groups. Only the first can run today.

| Check | From | Ready? | Who |
| --- | --- | --- | --- |
| S3 refuses a part of the wrong length | J3 (#45) | Yes, in `smoke.ts` | The run |
| `abortOtherUploads` ends a replaced upload but not the new one | J3 (#45) | Yes, in `smoke.ts` | The run |
| The bucket's 1-day rule for unfinished uploads | J3 (#45) | Yes, in `confirm.sh` (the stand-up runs it) | The run |
| API stage throttled at rate 50, burst 100 | J3 (#45) | Yes, one AWS CLI command (kept sandbox) | You |
| A WAV, AIFF and FLAC reach `awaiting_splits` on the real Fargate image; note the time per job | H, J4 | **No:** a smoke check to write | A session, then the run |
| A playlist declared WAV fails as "not a valid WAV" | J4 (#47) | **No:** part of the same smoke check | A session, then the run |
| `getPlayback`, `getCover`, `getPublicRelease`, `recordPlays` answer with no `AccessDenied` | J3 (#45) | **No:** needs a kept sandbox and test accounts; the account helper is not written | A session, then you |
| `tests/cross-cloud/run-live.ts` against AWS | G2 | **No:** same helper | A session, then you |

**What must be ready**

- [ ] A session adds the processing smoke check to `deploy/aws/scripts/smoke.ts`, and it is
  merged. See "The session first" in the next section.
- [ ] For the API checks: a session writes the helper that makes throwaway accounts of each type on
  a kept sandbox and writes their tokens to a file outside the repository (step 6, decision 6 in
  the handoff). Or leave these checks for a later run.
- [ ] AWS SSO signed in, for the commands you run by hand: `aws sso login --profile milkcrate-dev`,
  then `export AWS_PROFILE=milkcrate-dev`.
- [ ] `milkcrate-dev` holds nothing but the Phase 0 sandbox (rule L8), and no `MilkCratePhase0`
  stack is left from an earlier run.

The ffmpeg 5.1 tests are a separate runbook (`ffmpeg-5.1-tests.md`) and do not need the sandbox.

## Starting the run

The run starts when the branch `aws-sandbox-run` is created, and touches AWS only after you
approve it.

**The session first (one pull request, before the run).** Ask a session to add one check to
`deploy/aws/scripts/smoke.ts`, after the Fargate check:

- make one release per file through session B's SQL functions, each with one track: a small WAV,
  AIFF and FLAC (made with ffmpeg on the runner), plus J4's HLS playlist declared `wav` (its text
  is in step 9 of `docs/phase0-handoff.md`);
- upload each master to S3 with its real SHA-256, queue the job, and start the real Fargate task
  for it;
- expect the three real files to reach `awaiting_splits` with a stream key, duration and sample
  rate, and the playlist to reach `failed` with
  `Track 1, "<title>": this file is not a valid WAV. Export it again and upload it.`;
- print the time each job took, and clean up what it made.

The session also needs ffmpeg on the runner (`apt-get install ffmpeg` in the workflow, or the
audio made in the task). That changes `.github/workflows/aws-sandbox.yml`, so the brief must allow
it.

**Step 1. Decide whether to keep the sandbox.** Keep it if you will do the by-hand checks
afterwards (steps 6 and 7, including the throttle check). In GitHub: Settings, Environments,
`aws-sandbox`, Environment variables: set `MC_SANDBOX_KEEP` to `true`. Leave it unset for a run
that tears itself down. Make sure `MC_SMOKE_SKIP_WORKER` is unset, or the Fargate checks are
skipped.

**Step 2. Create the branch.** Ask the session to create `aws-sandbox-run` from the latest
`milk-crate-backend-poc`, or create it yourself in the GitHub branch list. Note the commit it
starts from.

Expected: a new run under Actions, "AWS sandbox run", waiting for approval.

**Step 3. Check the commit, then approve.** Open the run. Check that its commit is the latest on
`milk-crate-backend-poc` (rule L8). Then choose Review deployments, tick `aws-sandbox`, and
approve.

Expected: the job starts. Stand-up takes about 30 minutes (mostly Aurora and CloudFront).

## The checks

Watch the job's log. Each smoke check prints one line: `ok - <name>` or `FAIL - <name>: <error>`.
One failure does not stop the others, and the run ends with `All smoke checks passed.` or
`<n> checks failed.` Copy any `FAIL` line into a session.

**Step 4. The stand-up checks.** The stand-up ends by running `confirm.sh`. Expected: two SES
problems (domain not verified, SES in its sandbox), which are normal while there is no email
domain, and nothing else. In particular, no line reading
`bucket ... has no rule to abort unfinished uploads after 1 day`.

**Step 5. The smoke test.** Expected `ok` lines, in order:

| Line in the log (`ok - ...`) | Checks |
| --- | --- |
| `Data API: ...` (three lines) | Parameters, error mapping, failed transactions |
| `upload: presigned part with no part checksum, ...` | S3 uploads |
| `upload: S3 refuses a part of the wrong length (each part URL signs its size)` | J3's M3 fix |
| `upload: resume lists ...`, `confirm: ...` (two), `readHead: ...` | Resume and confirm |
| `upload: abortOtherUploads ends the replaced upload and keeps the new one` | J3's fix |
| `CloudFront: ...` (two) | Signed cookies; masters never served |
| `Cognito: ...` | The account-type claim |
| `Schedules: ...` (three) | Go-live runs and the dead-letter queue |
| `Fargate: two starts for one job id make one task, ...` | The worker image runs (with J4's change) |
| *The new processing check, once added* | Three releases `awaiting_splits`, the playlist `failed` as "not a valid WAV", with the time per job |

`skip - SES` is expected (no `MC_SMOKE_EMAIL_TO`). If the playlist release fails with any other
reason (such as "damaged"), ffmpeg read it as something else: stop and bring it to a session. Note
the time per job for the 4-hour limit.

**Step 6. By hand, only with a kept sandbox** (`MC_SANDBOX_KEEP=true`). Find the API id:

```bash
aws apigatewayv2 get-apis --query "Items[?Description=='Milk Crate Phase 0 API'].ApiId" --output text
```

Then the throttle:

```bash
aws apigatewayv2 get-stage --api-id <api id> --stage-name '$default' --query DefaultRouteSettings
```

Expected: `ThrottlingRateLimit` 50.0 and `ThrottlingBurstLimit` 100.

**Step 7. The API checks, once the account helper exists.** With the kept sandbox and the
helper's token file, run `tests/cross-cloud/run-live.ts` (its README has the command), or call by
hand. Expected: `getPlayback` and `getCover` give cookies that open the stream and the cover; a
missing stream is a 404; `getPublicRelease` and `recordPlays` answer; and their CloudWatch logs
show no `AccessDenied`.

## Tear-down, and what to record

A run without `MC_SANDBOX_KEEP` tears itself down, even after a failure (about 22 minutes).
Expected at the end of the log: `MilkCratePhase0: destroyed`.

**Step 8. A kept sandbox.** When the by-hand checks are done, create the branch
`aws-sandbox-teardown` from `milk-crate-backend-poc`, approve its run the same way, and wait for
`MilkCratePhase0: destroyed`. Then set `MC_SANDBOX_KEEP` back to unset.

**Step 9. Clean up the branches.** Delete `aws-sandbox-run` (and `aws-sandbox-teardown`) in the
GitHub branch list. A session cannot delete branches. To run again, create the branch again.

**Step 10. Record the run.** Give a session these, for "Done" in `docs/phase0-handoff.md`:

- [ ] the run's link, date and commit;
- [ ] each `FAIL` line, or "all ok" (with SES skipped);
- [ ] the time per processing job, from the new check;
- [ ] the throttle values, and the API check results, if done;
- [ ] that tear-down ended with `MilkCratePhase0: destroyed`.

Source: `.github/workflows/aws-sandbox.yml`, `deploy/aws/README.md` ("Sandbox run from GitHub"),
`deploy/aws/scripts/smoke.ts` and step 9 of `docs/phase0-handoff.md`, on `milk-crate-backend-poc`
as of 25 November 2026.

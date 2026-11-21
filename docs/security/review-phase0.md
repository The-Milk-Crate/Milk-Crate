# Phase 0 security and abuse review (session I)

Reviewed: `milk-crate-backend-poc` at `5cf86dc` (after #37, G3's fixes). Read-only. Nothing was
fixed. No network calls to anything real. Reproductions ran on session B's throwaway local
PostgreSQL 16 with session G's handlers and fakes, from scratch files that are not committed.

## Summary

16 findings: **2 high, 5 medium, 9 low**. Plus a short list of theoretical concerns.

The five that matter most:

1. **H1. Anyone signed in can fake unlimited qualified streams** (confirmed). The server trusts the
   client's positions and device times. One free `end_user` account made 150 qualified streams
   in 3 requests with made-up 2020 timestamps.
2. **H2. Supabase: an artist can replace a live release's cover after review** (confirmed). The
   Supabase upload token writes straight to the final key, with upsert, for about 2 hours. An
   open cover upload is never closed by submit, approval or publish, and `getUpload` keeps
   signing a fresh token for it.
3. **M1. The invitation email can be used to spam anyone** (confirmed). One `putRights` call
   sends up to 99 invitations to any addresses, with artist-chosen text in the subject. No limit
   across calls. Resend's free plan stops at 100 a day, so it also blocks real email.
4. **M2. No rate limits or quotas on any endpoint** (confirmed in code). The contract promises a
   429 on `createRelease` and `recordPlays`; neither has a limit. The free Supabase project's
   500 MB database can be filled by one account.
5. **M3. AWS: presigned part URLs do not fix the part size, and replaced uploads are never
   aborted** (code confirmed, S3 cost suspected). An artist can park terabytes of parts for 7 days.

### How the reproductions were run

A scratch script started a temporary PostgreSQL 16 cluster (as `core/test/run.sh` does),
applied `db/migrations/`, and ran one scratch test file with `node --test` that imports
`core/test/helpers.ts` and `core/test/fakes.ts`. The output lines:

```
R1: qualified streams from 3 requests by one end_user: 150
R2: the invitee's correct code after 10 wrong ones from another account: 429 rate_limited
R3: release live; getUpload on the open cover upload: 200 (tus, headers {"x-signature":"fake"}); confirm: 409 wrong_state; upload row still: open
R4: invitation emails from 3 putRights calls on one draft: 297; subject data: Free prize, click here
R5: [["A Famous Producer","accepted"],["Me","accepted"],["Another Writer","accepted"]]
```

Each finding below says which line belongs to it and what the test did.

## Findings

### H1. Qualified streams can be faked by any signed-in account

- **Severity: high.** Qualified streams are what the "fair streams" model pays on. Anyone can
  sign up (`enable_signup = true` on Supabase, `selfSignUpEnabled` on Cognito) and inflate any
  live track, or a competitor's.
- **Confirmed** (R1).
- **Where:** `db/migrations/0005_plays.sql:127` (listened time is the smaller of the client's
  position change and the client's device-time change), `:139`; `core/src/handlers/playback.ts:63`.
- **How:** Send `start` at `positionMs: 0` and `end` at `positionMs: 30000` with `occurredAt`
  30 seconds apart, under a new random `playId`. 50 plays fit in one 100-event batch, and any
  number of batches can be sent with new `Idempotency-Key`s. Nothing checks the server receive
  time, the track's real duration, overlapping plays by one user, or that the user ever asked
  for a playback grant. R1 used device times in 2020 and they counted.
- **Fix:** Measure time with the server's receive times (and cap device time skew), cap
  `positionMs` at the track's `duration_ms`, refuse overlapping plays per user, require a recent
  `getPlayback` grant for the track, and rate-limit per user. This changes the qualified-stream
  rule that was settled with session B ("stays as built for Phase 0"); see decisions.
- **Owner:** B (`db/migrations/0005_plays.sql`), G (`recordPlays`), decision by K Marcus.

### H2. Supabase: upload tokens are reusable write grants to the final key; an open cover upload survives review

- **Severity: high** (Supabase only). An artist can show reviewers one cover and then put any
  image (offensive, a phishing QR code, someone else's art) on the live release, skipping review
  and the square check. AWS is not affected: S3 completes a multipart upload only when the
  server confirms it.
- **Confirmed** (R3 for the handler path; the Supabase behaviour is plain in the code).
- **Where:**
  - `deploy/supabase/src/storage.ts:156-175`: the token from `/object/upload/sign` is made with
    `x-upsert: true` and handed to the client. It is a signed token for the final key
    (`art/.../cover/original` or `masters/.../original`), valid about 2 hours. With it the client
    can open its own TUS upload (its own `Upload-Length`) or use the plain signed-upload PUT,
    as many times as it likes, overwriting the object.
  - `deploy/supabase/src/storage.ts:271-273`: `getUpload` signs a fresh token on every call.
  - `core/src/handlers/uploads.ts:143-153`: `getUpload` checks only that the upload row is
    `open`, not the release state.
  - `db/migrations/0007_release_functions.sql:142` refuses a cover confirm outside the editable
    states, so the row stays `open` for ever. Nothing closes open uploads at submit, approval or
    publish (only a takedown cancels them, `0006_audit_takedown.sql:24` onwards).
- **How (R3):** Confirm a valid square cover. Start a second cover upload and leave it open.
  Submit, get approved, publish: the release is `live`. `getUpload` on the open cover upload
  still answers 200 with a new token; `confirmUpload` answers 409 and the row stays `open`.
  On real Supabase the attacker then uploads any JPEG or PNG to the cover key with that token;
  `getCover` signs whatever is there. The same token also lets the client overwrite a master
  for up to 2 hours after it was confirmed or processed, so the stored master no longer matches
  its SHA-256 or its streaming copy, and lets a client confirm with a file of the right size and
  swap it before the worker reads it.
- **Fix:** Close (cancel) open uploads when a release is submitted, and have `getUpload` refuse
  when the release is no longer in a state that allows that kind of upload. Better: have clients
  upload to a staging key per upload and have `confirmUpload` copy or move it to the final key on
  the server, so no client ever holds a write grant for a reviewed object. The staging key would
  change what `objectKey` means in the contract; see decisions.
- **Owner:** E (`deploy/supabase/src/storage.ts`), G (`getUpload`), B (close uploads on submit).

### M1. The invitation email can spam any address with artist-chosen text

- **Severity: medium.** Spam and phishing from Milk Crate's own sending domain, a damaged
  sender reputation (SES can suspend the account), and on the free Resend plan (100 a day) one
  call stops every other email that day. Needs an approved artist account.
- **Confirmed** (R4).
- **Where:** `core/src/handlers/rights.ts:143` onwards (`putRights`), `:220` (`issueInvite` for
  every new invited party); the per-day limit in `db/migrations/0003_rights_invites.sql:160` is
  per party, so new parties always pass. Templates: `deploy/supabase/src/email-templates.ts:11`
  (and the AWS copy) put `artistName` and `releaseTitle` in the subject.
- **How:** One `putRights` with 99 invited parties sends 99 emails. Replacing the parties and
  calling again sends 99 more. R4 sent 297 in three calls on one draft, with the title
  "Free prize, click here" in every subject. `createRelease` has no limit, so this scales.
- **Fix:** Cap invitations per release, per artist per day, and per recipient address per day,
  and refuse when over. `putRights` has no 429 in the contract, so either the contract gains one
  or over-limit invitations are left unsent (as today) and sent later with `resendInvitation`.
- **Owner:** G, B (a per-artist and per-address counter), decision by K Marcus.

### M2. No rate limits or quotas on any endpoint

- **Severity: medium.** One account can fill the free Supabase project's database (500 MB) or run
  up Lambda, Data API and Fargate/Fly costs. The free plan goes read-only or pauses when over
  quota, which takes the whole deployment down.
- **Confirmed** in code (no limit exists); the real platform limits are suspected.
- **Where:** nothing in `core/src/handlers/`, `deploy/supabase/` or `deploy/aws/infra/stack.ts`
  (no API Gateway throttling, no WAF). The contract lists 429 for `createRelease` and
  `recordPlays`, but neither handler can return it.
- **How:** `recordPlays` stores every event for any existing track (live or not), 100 per
  request, with no limit on requests. `createRelease` makes up to 100 tracks per call with no
  limit on calls. Each confirmed upload can start a 2-CPU Fly machine or a Fargate task; an
  artist can loop a master through `failed` and back to `processing`. `listReleases` and
  `getPlayback` have no limits either.
- **Fix:** Per-user counters in the database (as B already does for wrong codes) for plays,
  releases, uploads and jobs; API Gateway stage throttling on AWS; a cap on concurrent jobs per
  artist; and the 429s the contract already promises.
- **Owner:** G and B (counters), F (API Gateway throttling), E (Supabase has no gateway limit;
  the counters must do it), decision by K Marcus on the numbers.

### M3. AWS: part URLs do not fix the part size, and replaced multipart uploads are never aborted

- **Severity: medium.** Storage cost abuse by an approved artist. Incomplete multipart parts are
  billed like stored objects.
- **Code confirmed; the S3 behaviour is suspected** (standard S3 behaviour for a presigned
  `UploadPart` without a signed `Content-Length`, not tried on real S3).
- **Where:** `deploy/aws/src/storage.ts:163` presigns `UploadPartCommand` with no
  `ContentLength`, so each part URL accepts up to 5 GiB.
  `db/migrations/0007_release_functions.sql:58` and `:76` mark the old upload `replaced` but
  nothing aborts its S3 multipart upload; `deploy/aws/infra/stack.ts:109` aborts unfinished
  uploads only after 7 days.
- **How:** Start a 5 GiB master upload (640 parts) and send 5 GiB to each part URL: about 3 TB
  of parts. `confirmUpload` refuses the size, the upload stays open, and the parts stay for 7
  days. Start another upload for the same track (the old one is only marked `replaced`) and
  repeat, across any number of tracks and releases.
- **Fix:** Put `ContentLength` (the planned part size, smaller for the last part) into each
  presigned part so S3 refuses other sizes; abort the S3 multipart upload when an upload is
  replaced; shorten the lifecycle rule to a day or two.
- **Owner:** F (`deploy/aws/src/storage.ts`, `infra/stack.ts`), G or B (abort on replace).

### M4. The worker runs ffprobe and ffmpeg on hostile files with format auto-detection, next to the database owner's credentials

- **Severity: medium.** A file that exploits an ffmpeg bug, or tricks a demuxer into opening
  other files or URLs, runs in a process whose environment holds the Supabase service role key
  and the `postgres` owner password (Fly), or whose task role reads the database secret and
  deletes any object (Fargate). That is the whole deployment.
- **Suspected.** Here, ffmpeg 6.1 refused the two known tricks (an HLS playlist and an
  `ffconcat` file pointing at a local HTTP server: no request was made). The images install
  Debian bookworm's ffmpeg 5.1, which was not tested.
- **Where:** `worker/src/media.ts:71-77` (`ffprobe ... file`) and `:181-187` (`ffmpeg -i input`):
  no `-f`, no `-protocol_whitelist`. Container: `deploy/*/worker/Dockerfile`,
  `deploy/supabase/scripts/fly-secrets.env.example`, `deploy/aws/infra/stack.ts:185-200`.
- **How:** Upload a "master" whose bytes are a playlist or another container format. ffprobe
  opens it as whatever it detects before the worker checks `format_name`.
- **Fix:** Pass `-f wav|aiff|flac` (from the declared format) and `-protocol_whitelist file` to
  both commands; run them with an empty environment (`env: {}` in `spawn`) and, if possible,
  as a separate user with no network.
- **Owner:** H (`worker/src/media.ts`), E and F (worker secrets and roles).

### M5. `build.yml` uses third-party actions by mutable tag while holding the updater signing key

- **Severity: medium** (low chance, very high impact). If `tauri-apps/tauri-action@v0`,
  `Swatinem/rust-cache@v2` or `dtolnay/rust-toolchain@stable` is taken over, the job can read
  `TAURI_SIGNING_PRIVATE_KEY` and sign a malicious update that every desktop app installs.
- **Confirmed** (plain in the file). Not Phase 0 work and outside this session's rules:
  `build.yml` must not be changed here.
- **Where:** `.github/workflows/build.yml:32, 75, 77, 83, 87, 104, 120`. The Phase 0 workflows
  pin every action by SHA.
- **Fix:** Pin every action in `build.yml` by commit SHA, as `phase0-checks.yml` does.
- **Owner:** K Marcus (outside Phase 0).

### L1. Anyone who knows a release id and party id can lock the real invitee out

- **Severity: low.** After 10 wrong codes in an hour from any account, the correct code is
  refused too, and a script can keep it locked. The ids are UUIDs known only to the owner,
  staff and the invitee today, which keeps this low.
- **Confirmed** (R2: 10 wrong codes from a second `end_user`, then the invitee's correct code
  answered 429 `rate_limited`).
- **Where:** `db/migrations/0003_rights_invites.sql:266` and `:343` (the lock is checked before
  the code).
- **Fix:** Count wrong codes per caller and party (or per caller), or check a correct code before
  the lock, so only the guesser is slowed down. Codes are 256-bit, so guessing is not the risk.
- **Owner:** B.

### L2. Parties with no email are accepted at once, under any name

- **Severity: low.** The release owner's own share is "a party with no email", and there is no
  limit on how many. An artist can list "A Famous Producer" at 50% as accepted without asking
  them. Reviewers may read accepted parties as consent.
- **Confirmed** (R5: all three no-email parties came back `accepted`).
- **Where:** `core/src/handlers/rights.ts:174`; `db/migrations/0003_rights_invites.sql:93-97`.
- **Fix:** At most one owner party per side, named from `api_accounts.artist_name`, or show
  reviewers which shares are the owner's. Decision.
- **Owner:** G and B, decision by K Marcus.

### L3. The cover check has no upper limit on width and height

- **Severity: low.** A 20 MiB PNG or JPEG whose header says, say, 60000 x 60000 passes; listeners'
  apps that decode it may run out of memory. Combined with H2 it reaches a live release without
  review.
- **Confirmed** in code: only a minimum is checked, and no pixels are decoded.
- **Where:** `core/src/handlers/uploads.ts:233-236`, `core/src/handlers/image.ts`.
- **Fix:** Add a maximum (for example 6000 pixels) and say it in the contract's description.
- **Owner:** G.

### L4. AWS: every operation's Lambda has the same broad role

- **Severity: low.** A bug in any one function (for example `getPublicRelease`) can read the
  CloudFront private key and the database owner secret, delete any object, start worker tasks,
  create schedules (which run SQL as the owner through `runRole`) and send email.
- **Confirmed** in code.
- **Where:** `deploy/aws/infra/stack.ts:366-417`.
- **Fix:** One role per operation with only what it uses (for example only `takedownRelease`
  deletes; only `publishRelease` creates schedules; only `getPlayback` and `getCover` read the
  CloudFront key). On Supabase the `postgres` owner connection was settled; it has the same
  breadth.
- **Owner:** F.

### L5. Supabase auth: default password rules and no second factor for staff

- **Severity: low.** `config.toml` sets no `minimum_password_length` or password requirements,
  so pushing it leaves Supabase's defaults (6 characters). Staff accounts (`administrator`) can
  take down any release. Cognito asks for 12 characters.
- **Suspected** (Supabase defaults; not checked on a live project).
- **Where:** `deploy/supabase/supabase/config.toml:28` onwards.
- **Fix:** Set `minimum_password_length = 12` and `password_requirements`, and plan MFA for staff
  on both deployments.
- **Owner:** E (and F for MFA).

### L6. Storage error text reaches clients

- **Severity: low.** Up to 200 characters of a Supabase Storage error body (bucket names, keys,
  internal messages) can come back in a 400.
- **Confirmed** in code.
- **Where:** `core/src/handlers/http.ts:99` returns the storage error's message;
  `deploy/supabase/src/storage.ts:150` puts the response body in it.
- **Fix:** Return a fixed message for storage 400s and log the detail.
- **Owner:** G (and E).

### L7. Live invite codes sit in the email provider's logs

- **Severity: low.** Resend keeps sent messages, bodies included, so anyone with access to the
  Resend account (or a leaked Resend key with read scope) can read every code still valid
  (14 days). SES does not keep bodies.
- **Suspected** (Resend's retention not checked here).
- **Where:** `deploy/supabase/src/secrets-email.ts`, the `split_invitation` template.
- **Fix:** Use a send-only Resend key, turn off body retention if Resend allows it, and keep the
  Resend account to K Marcus.
- **Owner:** E, K Marcus.

### L8. The sandbox role is close to admin in `milkcrate-dev`

- **Severity: low.** `MilkCrateSandboxDeploy` has `PowerUserAccess` and can use the CDK bootstrap
  roles, which are admin by default. Any run K Marcus approves runs the code of the
  `aws-sandbox-run` branch with that power. The handoff notes that approving a queued run worked
  after its branch was deleted, so the approver may not see which commit runs.
- **Confirmed** in code.
- **Where:** `deploy/aws/infra/github-oidc.json`, `.github/workflows/aws-sandbox.yml`.
- **Fix:** Keep `milkcrate-dev` free of anything else; before approving, check the run's commit
  on its page. Narrow the role later if the account gets other uses.
- **Owner:** F, K Marcus.

### L9. Dependency notes

- **Severity: low.** `npm audit` (it reached the registry): `core/`, `worker/`, `deploy/supabase/`
  and `tests/cross-cloud/` have 0 advisories. `deploy/aws/`: 2 moderate (minimatch inside
  `aws-cdk-lib`, build time only). `milk-crate/`: 3 in dev tools only (vitest's
  `@vitest/mocker` moderate, `tinypool` critical; they matter only when running tests on
  hostile input). The Edge Function imports `npm:jose@6.2.3` and `npm:postgres@3.4.9` by exact
  version but has no `deno.lock`, so their contents are not pinned by hash.
- **Confirmed.**
- **Where:** `deploy/supabase/supabase/functions/deno.json`, `deploy/aws/package-lock.json`,
  `milk-crate/package-lock.json`.
- **Fix:** Add a `deno.lock` for the function; update `aws-cdk-lib` and `vitest` when convenient.
- **Owner:** E, F, the app.

## Theoretical concerns (no realistic harm found)

- A taken-down streaming copy can stay in CloudFront's edge cache; only holders of cookies
  issued before the takedown can read it, for at most 600 seconds.
- `recordPlays` answers 202 for a known track id and 422 for an unknown one, and `getInvitation`
  answers 404 or 403 depending on whether a party belongs to a release. Both need random UUIDs.
  (`recordPlays`' behaviour was settled with session C.)
- Invite hashes are compared with SQL `<>`, not in constant time. They are hashes of 256-bit
  codes, so timing gives nothing.
- C's sync checks for a second role before it takes its per-account lock, so an artist approval
  and an `admins` row committed at the same moment can both pass. The settled fallback then
  gives `administrator`, and the artist endpoints refuse the account.
- On Supabase, any `api_` object made after the stand-up (outside `apply-sql.sh`) gets
  Supabase's default grants until `db/supabase/0006_grants.sql` runs again.
- `listReleases` with a cursor whose time looks right but is not a real time (for example
  month 13) answers 500, not 400.
- Request bodies are read whole (`readJsonObject`); API Gateway (10 MB) and Lambda (6 MB) cap
  them on AWS; the Supabase Edge limit was not checked.
- The late takedown pass assumes a TUS upload cannot continue after its token expires.

## Checked, nothing found (by area)

1. **Authentication.** Supabase: JWKS from the project, ES256/RS256 (HS256 only with the legacy
   secret, no algorithm confusion), issuer and `aud: authenticated` checked, expiry checked by
   `jose`, `role` must be `authenticated`, anonymous sign-ins refused, `account_type` read only
   from the top-level claim, an unknown value refused. Edge Function JWT verification is turned
   off (`--no-verify-jwt`) on purpose and Identity checks every token. AWS: pool JWKS, RS256,
   issuer, `token_use: access`, `client_id` in the allowed list. Missing, malformed, expired,
   foreign or ID tokens give 401 on both.
2. **Authorization against the contract.** Every operation's `x-account-types` matches its
   handler's `allow` or state checks (`getRelease`/`listReleases`: artist own, administrator,
   internal; `reviewRelease`: administrator, internal; `takedownRelease`: administrator; invitee
   operations refuse staff; the rest any signed-in account). Ownership: another artist's
   release, upload, track, party and cover are 404 (release owner checked, uploads joined to
   their release, tracks and parties scoped to the release id). `db/supabase/0006_grants.sql`
   grants clients only the two invitee wrappers; every `api_` table, view, sequence and function
   is revoked from `anon`, `authenticated` and `public`, so PostgREST serves nothing else.
3. **The account-type claim.** One `api_accounts` row per account (primary key), artist type
   fixed by trigger. Staff and artist endpoints check the row on every call, so a removed or
   suspended role stops at once. The hook never reads `user_metadata`; `public.artists.status`
   is guarded by the app's trigger; `public.admins` has no client write policy; Cognito groups
   change only through admin APIs. The both-roles fallback follows `db/account-claim.json`.
4. **The release state machine.** The moves are enforced by B's triggers on every write,
   whoever writes; clients have no grants. Publishing needs `approved`; nothing leaves
   `taken_down`; details, tracks and rights are fixed outside their editable states; the
   go-live schedule moves only `scheduled`. Publish and takedown both lock the release row. The
   one way around review is storage, not the database (H2).
5. **Invitations.** 32 random bytes, base64url; only the SHA-256 is stored; single use under
   concurrency (row lock); 14-day expiry; resend replaces the hash; 10 wrong codes an hour
   locks; codes travel only in POST bodies and the email, never in responses, URLs or logs.
   Issues: L1, L7, and M1 for sending.
6. **Uploads and keys.** Keys are built in SQL from ids (never from input) and checked by
   triggers and by the storage modules' patterns; `masters/` and `art/` cannot be mixed; size
   and format limits are checked; another artist's upload is 404; confirm checks size (and
   CRC64NVME on S3) and the worker checks the SHA-256. Issues: H2, M3, L3.
7. **Reads.** Supabase links are for one object, 600 seconds; CloudFront cookies cover one
   track's stream folder or one cover folder, 600 seconds; masters can never be signed (key
   patterns) and CloudFront is denied `masters/*` in the bucket policy; hidden and missing
   releases both give 404. Grants are shareable until they expire (settled).
8. **Plays.** The idempotency key is scoped to the user (primary key `user_id, idempotency_key`),
   so one user cannot block or replay another's; batches are capped at 100 events. Issues: H1, M2.
9. **Takedown.** The database part commits first (streaming keys and cover row cleared, open
   uploads cancelled), then the `masters/`, `streams/` and `art/` prefixes are deleted (AWS
   aborts unfinished uploads first); the hourly sweep retries and does a late pass after 2
   hours. Audit rows are written only by the server; clients cannot reach them.
10. **Injection and input.** Every query is parameterised; the only SQL text built in code uses
    constant column names, and the schedule SQL takes function and argument names from the
    catalog after strict patterns. Email subjects drop line breaks, HTML is escaped, and the
    providers' APIs are JSON. Unexpected errors are a 500 with no details. Issue: L6.
11. **Secrets and configuration.** No keys, tokens or passwords in the tree or the history of
    any branch (the app's Supabase publishable key appears, which is public by design). Secret
    files are git-ignored; scripts read secrets from files or the shell and never print them. S3
    blocks public access and enforces TLS; the Supabase buckets are private with type and size
    limits; the service role key never reaches a client (clients get the publishable key and a
    one-object upload token). Issues: L4, L5, L8, M4.
12. **Rate limits and abuse.** Wrong invite codes (10 an hour) and resends (5 a day per party)
    are limited. Everything else is not: M1, M2.
13. **Dependencies and workflows.** Few runtime dependencies, exact versions, lockfiles present,
    audits clean at runtime. Phase 0 workflows pin actions by SHA, use `contents: read`,
    `persist-credentials: false`, `pull_request` (not `pull_request_target`) and no secrets; the
    sandbox workflow needs K Marcus's approval and its role trusts only that environment. Issues:
    M5, L8, L9.
14. **Desktop client (`milk-crate/src/lib/api/`).** It keeps no token of its own (it asks
    `getToken` on each request), sends it only as `Authorization` to the API base address, and
    returns the contract's errors as typed values. No screen uses it yet. Nothing found.

## What could not be checked here

K Marcus should check these by hand after the stand-up:

- **Supabase signed upload tokens** (H2): that one token can open a second TUS upload and use
  the plain signed-upload PUT with upsert, and how long it lasts. Whether a started TUS upload
  can still send data after its token expires (the late takedown pass relies on it not).
- **Supabase bucket types:** that `allowed_mime_types` refuses an upload whose declared type is
  not allowed, and what `Content-Type` a signed read then serves.
- **Supabase auth after `config push`:** password rules, email confirmation, sign-up and the
  hook all as intended; the Edge Function's request body limit.
- **S3:** that a presigned part URL accepts a part of any size (M3), and that the lifecycle rule
  aborts old uploads.
- **CloudFront:** cookies for one track do not open another track or `masters/` (the handoff says
  the sandbox run checked this).
- **ffmpeg in the worker images** (M4): the bookworm 5.1 build's behaviour with playlists and
  concat files.
- **Cognito:** what happens to `email_verified` when a user changes their email.
- **Email:** Resend's retention of message bodies; SES still in the sandbox; the free Resend
  limit (100 a day) against invitation volume.
- **API Gateway:** the account's default throttling, since the stack sets none.

## Decisions for K Marcus

1. **Qualified streams (H1).** The rule was settled with B to stay as built for Phase 0. Keep it
   for the proof of concept, or tighten it now (server time, track duration, no overlapping
   plays, a recent playback grant)? Either way, no payout should rest on today's numbers.
2. **Supabase uploads (H2).** Close open uploads at submit and gate `getUpload` (small, no
   contract change), or move to staging keys with a server-side move at confirm (robust, but
   `objectKey` in the contract would no longer be the final key)?
3. **Rate limits (M1, M2).** The numbers, and where: database counters (works on both), plus API
   Gateway throttling on AWS. The contract has 429 for `createRelease` and `recordPlays` only;
   limiting `putRights`, `startUpload` or `listReleases` with a 429 needs a contract change.
4. **Owner shares (L2).** One owner party per side, named from the artist profile?
5. **`build.yml` (M5).** Pin its actions by SHA, outside Phase 0.

### Decided by K Marcus (21 November 2026)

Each finding's fix, as decided after the review. Owners as in each finding.

| Finding | Decision |
|---|---|
| H1 streams | Tighten now (reopens the settled rule): listened time from the server's receive times, `positionMs` capped at the track's `duration_ms`, overlapping plays by one user refused. A recent playback grant and per-user limits are left for later (per-user limits come with M2). |
| H2 Supabase uploads | Now: `submitRelease` cancels open uploads, and `getUpload` refuses when the release state no longer allows that kind of upload (B and G, no contract change). Phase 1: staging files per upload, moved to the final key by the server at confirm. |
| M1 invitation email | Caps: 20 invited parties per release, 50 invitations per artist per day, 3 per recipient address per day. Over a cap the party is saved, no email goes, and the artist resends later (as the daily limit works today). No contract change. |
| M2 rate limits | Database counters: `recordPlays` 60 batches per user per minute plus a daily cap on stored events per user; `createRelease` 20 per artist per day; at most 2 running processing jobs per artist (the rest queue). API Gateway stage throttling on AWS (50 per second, burst 100). No 429 added to endpoints whose contract has none. |
| M3 AWS parts | Fix as proposed: each part URL signed with its size, the S3 upload aborted when an upload is replaced, the lifecycle rule down to 1 day. Check on the next sandbox run. |
| M4 ffmpeg | `-f` from the declared format, `-protocol_whitelist file`, and an environment with only `PATH`, for both commands. A separate user with no network later. |
| M5 `build.yml` | A separate small pull request into `main` that only pins the actions by commit. Outside Phase 0. |
| L1 lockout | A correct code is checked before the lock, so only wrong codes are slowed down. |
| L2 owner shares | At most one owner share (no email) per side; the server sets its name from the artist profile and ignores the name sent; otherwise 422. |
| L3 cover size | At most 6000 x 6000 pixels (422 above it); the contract's `startCoverUpload` description says so (wording only). |
| L4 AWS roles | A narrow listener role for `getPublicRelease`, `getPlayback`, `getCover` and `recordPlays` (Data API; `s3:GetObject` on `streams/*` and `art/*` and the CloudFront key only for the two read grants). The full role stays for the rest. |
| L5 Supabase auth | `minimum_password_length = 12` with lower, upper and digits in `config.toml` now. Staff MFA in Phase 1. |
| L6 error text | A fixed message for storage 400s; the detail goes to the log. |
| L7 Resend | Setup only: a sending-only Resend key, 2FA on the account, shorter body retention if offered. Into E's stand-up notes and the checks after stand-up. |
| L8 sandbox role | Process only: `milkcrate-dev` holds nothing else, and the run's commit is checked before approving. Into the handoff notes. |
| L9 dependencies | A `deno.lock` for the Edge Function (E) and `aws-cdk-lib` 2.278.0 or later (F) now; `vitest` 5 for the app later. |
| Invitation link | The email gets a link holding the release id and party id (never the code; it stays in the body). E's templates, G passes the ids. The app opens the link in Phase 1. The link's address (app scheme or web) is still to choose. |

## Other observations (not security)

- The invitation email carries the code but not the release id or the party id, which
  `getInvitation` and `respondToSplit` need in their paths. An invitee has no way to find them.
  If a link is added, keep the code out of the URL (it goes in the POST body).
- This brief says nothing is running anywhere yet, but `docs/phase0-handoff.md` records sandbox
  runs against the real `milkcrate-dev` AWS account. Worth checking that no `MilkCratePhase0`
  stack is left there.

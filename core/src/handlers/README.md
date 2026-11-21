# Shared handlers (session G)

One handler per operation in `api/openapi.yaml`, for both deployments. Import everything from
`core/src/handlers/index.ts`.

| Export | What |
|---|---|
| `createRelease`, `getRelease`, ... (all 21 operationIds) | `Handler<Modules>`: `(request, modules) => Promise<Response>`, with the default clock and random source. |
| `operations` | Every operation: `{ operationId, route, method, path, handler }`. `route` is `"METHOD /v1/path/{param}"`, as `serveOperation` (Supabase) and `routes.json` (AWS) take it. |
| `router` | One handler for every operation, by method and path. No match is the contract's 404. |
| `makeOperations(options)`, `makeRouter(options)` | The same with your own clock, random source, invite daily limit, minimum cover size or log (`CoreOptions`). |
| `makeApplyJobResult({ database })` | The worker's result: returns `(jobId: string, result: JobResult) => Promise<void>` for `Jobs.reportResult`. |
| `makeRequeueStuckReleases({ database, jobs }, options?)` | For each deployment's hourly sweep: returns `() => Promise<{ requeued, failed }>`, which queues a job for every release stuck in `processing` with no queued or running job for 15 minutes (a confirm whose enqueue failed). |
| `makeRetryTakedownDeletes({ database, storage }, options?)` | For the same sweep: returns `() => Promise<{ deleted, waiting, failed }>`, which deletes the files again for every takedown older than 15 minutes whose `files_deleted_at` is still empty. Only a delete that starts 2 hours or more after the takedown (`latePassMinutes`, the late pass) marks it done, so a file an upload stored after the takedown is deleted too; `takedownRelease` itself never marks it. |

The handler sees the contract's path (`/v1/...`). Each handler checks its own method and path,
so it works behind the router or as a function of its own.

## What the handlers rely on

- `Database`: `code` is the SQLSTATE on an error (session B's `MC403`, `MC404`, `MC409`, `MC422`
  map to the same HTTP status; the code word at the start of the message is the `Error` `code`).
  Every date, time and number is cast to text in the SQL, so results read the same on both.
- `ObjectStorage`: errors carry an HTTP-like `status`. 404 is 404; 413 (over the deployment's
  file size limit) is 422 `too_large`; 400 is 400. Anything else is a 500.
- `Identity.whoIs` gives the user id and the token's account type. Every call that needs the
  type also reads the caller's `api_accounts` row: a missing, changed or suspended row acts as
  `end_user` at once (settled with session C).
- Email failures and storage deletes after a takedown are logged, never answered as errors. The
  two sweep functions above pick up a missing job and undeleted takedown files.
- Decided by K Marcus: a cover is at least 1400 pixels a side; invitations are 5 sends per party
  per UTC day; the owner's own share is the party with no email; `respondToSplit` returns only
  the invitee's own party; `putRights` needs both sides at 100.

## Tests

```bash
bash core/test/run.sh
```

Starts a throwaway PostgreSQL 16 (session B's approach), applies `db/migrations/`, and runs every
test with Node's own runner against fake identity, storage, jobs, schedules and email. The read
access test is driven by `db/test/access-expected.json` itself, and the account-type test by
`x-account-types` in `api/openapi.yaml`. Set `DENO` to a deno binary to run the same tests on
Deno as well.

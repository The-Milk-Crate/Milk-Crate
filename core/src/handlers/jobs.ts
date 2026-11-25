// The worker's result. There is no HTTP operation for it: each deployment's Jobs.reportResult
// calls the function this returns.
import type { Database, JobResult, Jobs } from "../platform/index.ts";
import { isUuid } from "./validate.ts";

/** What `Jobs.reportResult` passes a result to. */
export type ApplyJobResult = (jobId: string, result: JobResult) => Promise<void>;

/**
 * Applies a worker's result by job id, through session B's `api_apply_job_result`: the job
 * row gives the release; success moves `processing` to `awaiting_splits`, failure moves it to
 * `failed` with the plain-words message. Safe to call twice, and a stale result (not the
 * release's newest job, or the release has moved on) changes nothing. Throws on an unknown job
 * id (`DatabaseError` MC404) or a failure with no message.
 */
export function makeApplyJobResult(modules: { database: Database }): ApplyJobResult {
  return async (jobId, result) => {
    if (!isUuid(jobId)) throw new Error(`not a job id: ${jobId}`);
    const message = result.ok ? null : result.message;
    if (!result.ok && (typeof message !== "string" || message.trim() === "")) {
      throw new Error("a failed job needs a plain-words message");
    }
    await modules.database.query(
      "select a.finished from public.api_apply_job_result($1::uuid, $2::boolean, $3::text) a",
      [jobId, result.ok, message],
    );
  };
}

export interface RequeueOptions {
  /** Only releases that have been processing this long with no job. Default 15 minutes. */
  olderThanMinutes?: number;
  /** At most this many per call. Default 50. */
  limit?: number;
  /** Where a failed enqueue is written. Default: `console.error`. */
  log?: (message: string) => void;
}

export interface RequeueResult {
  /** Releases that got a new job. */
  requeued: string[];
  /** Releases whose enqueue failed again; the next sweep tries them again. */
  failed: string[];
}

/**
 * Finds releases stuck in `processing` with no queued, waiting or running job, and queues a job for
 * each. That happens when `confirmUpload` moved the release to processing but `Jobs.enqueue`
 * then failed, so there is no job row for the hourly sweep to find. Each deployment's hourly
 * sweep calls this. The grace period leaves alone a confirm whose enqueue is still under way.
 */
export function makeRequeueStuckReleases(
  modules: { database: Database; jobs: Jobs },
  options: RequeueOptions = {},
): () => Promise<RequeueResult> {
  const minutes = options.olderThanMinutes ?? 15;
  const limit = options.limit ?? 50;
  const log = options.log ?? ((message: string) => console.error(message));
  return async () => {
    const rows = await modules.database.query<{ id: string }>(
      `select r.id::text as id
         from public.api_releases r
        where r.state = 'processing'
          and r.updated_at < now() - make_interval(mins => $1::integer)
          and not exists (select 1 from public.api_jobs j
                           where j.release_id = r.id and j.state in ('queued', 'waiting', 'running'))
        order by r.updated_at
        limit $2::integer`,
      [minutes, limit],
    );
    const result: RequeueResult = { requeued: [], failed: [] };
    for (const { id } of rows) {
      try {
        await modules.jobs.enqueue({ kind: "process_release", releaseId: id });
        result.requeued.push(id);
      } catch (error) {
        // The release may have moved on since the query (MC409); either way, try next sweep.
        log(`release ${id}: requeueing its processing job failed: ${(error as Error)?.message ?? String(error)}`);
        result.failed.push(id);
      }
    }
    return result;
  };
}

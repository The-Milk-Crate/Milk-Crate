// The worker's result. There is no HTTP operation for it: each deployment's Jobs.reportResult
// calls the function this returns.
import type { Database, JobResult } from "../platform/index.ts";
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

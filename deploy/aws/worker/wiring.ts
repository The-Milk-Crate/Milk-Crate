import type { JobResult } from "../src/core.ts";

/**
 * Session G's job-result function, which applies the result through api_apply_job_result and
 * moves the release state. Waiting on G to state its path (an open point); until then the
 * worker cannot report, and the job stays `running` until the hourly sweep's time limit.
 */
export async function applyJobResult(jobId: string, _result: JobResult): Promise<void> {
  throw new Error(`cannot report job ${jobId}: session G's job-result function is not wired yet`);
}

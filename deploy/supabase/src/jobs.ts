import type { Database, JobRequest, JobResult, Jobs } from "./core.ts";
import type { WorkerStarter } from "./fly.ts";

/** Session G's function that applies a worker's result and moves the release state. */
export type ApplyJobResult = (jobId: string, result: JobResult) => Promise<void>;

export interface SupabaseJobsOptions {
  database: Database;
  /** Wakes a worker. Without it, jobs wait for the hourly sweep. */
  worker?: WorkerStarter;
  /** Session G's job-result function. Not wired until G states its path. */
  applyResult?: ApplyJobResult;
  log?: (message: string) => void;
}

/**
 * The queue is session B's `api_jobs` table: `enqueue` adds a row with `api_create_job`, then
 * asks Fly for a machine to run it. If Fly cannot be reached the row stays `queued` and the
 * worker's hourly sweep picks it up, so the job is never lost.
 */
export function supabaseJobs(options: SupabaseJobsOptions): Jobs {
  const log = options.log ?? ((m: string) => console.warn(m));
  return {
    async enqueue(job: JobRequest): Promise<{ jobId: string }> {
      const rows = await options.database.query<{ id: string }>(
        "select public.api_create_job($1::uuid, $2::text) as id",
        [job.releaseId, job.kind],
      );
      const jobId = rows[0].id;
      if (options.worker) {
        try {
          await options.worker.startJob(jobId);
        } catch (error) {
          log(`job ${jobId} is queued, but the worker did not start: ${(error as Error).message}`);
        }
      }
      return { jobId };
    },

    async reportResult(jobId: string, result: JobResult): Promise<void> {
      if (!options.applyResult) {
        throw new Error("reportResult is not wired: waiting on session G's job-result function");
      }
      await options.applyResult(jobId, result);
    },
  };
}

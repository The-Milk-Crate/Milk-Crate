import type { Database, JobResult, Jobs } from "../src/core.ts";

export interface JobToRun {
  jobId: string;
  releaseId: string;
}

/** What processing does to a release's masters. Not decided yet (session H). */
export type ProcessRelease = (job: JobToRun) => Promise<JobResult>;

/**
 * The skeleton's processing: it does nothing to the masters and reports a plain failure, so a
 * release never moves on without real processing. Session H replaces it.
 */
export const processingNotBuilt: ProcessRelease = async () => ({
  ok: false,
  message: "Processing is not set up yet, so this release cannot move on. Nothing is wrong with your files.",
});

const CRASHED = "Processing stopped before it finished. Please upload the masters again, or contact us if it keeps happening.";

export interface WorkerDeps {
  database: Database;
  jobs: Jobs;
  process: ProcessRelease;
  log?: (message: string) => void;
}

/**
 * Runs one job: the one named, or else the oldest queued one. `api_job_started` claims it; it
 * returns false when the job is not queued (another machine took it, or it already ran), and
 * then this does nothing. Returns the job id it ran, or null.
 */
export async function runOneJob(deps: WorkerDeps, jobId?: string): Promise<string | null> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const rows = jobId
    ? await deps.database.query<{ id: string; release_id: string; kind: string }>(
        "select id, release_id, kind from public.api_jobs where id = $1::uuid and state = 'queued'",
        [jobId],
      )
    : await deps.database.query<{ id: string; release_id: string; kind: string }>(
        "select id, release_id, kind from public.api_jobs where state = 'queued' order by seq limit 1",
      );
  const job = rows[0];
  if (!job) {
    log(jobId ? `job ${jobId} is not queued; nothing to do` : "no queued jobs");
    return null;
  }
  const [{ started }] = await deps.database.query<{ started: boolean }>(
    "select public.api_job_started($1::uuid) as started",
    [job.id],
  );
  if (!started) {
    log(`job ${job.id} was taken by another worker`);
    return null;
  }
  if (job.kind !== "process_release") {
    await deps.jobs.reportResult(job.id, { ok: false, message: "This kind of job is not known." });
    return job.id;
  }

  let result: JobResult;
  try {
    result = await deps.process({ jobId: job.id, releaseId: job.release_id });
  } catch (error) {
    log(`job ${job.id} threw: ${(error as Error)?.stack ?? String(error)}`);
    result = { ok: false, message: CRASHED };
  }
  if (!result.ok && !result.message.trim()) result = { ok: false, message: CRASHED };
  await deps.jobs.reportResult(job.id, result);
  log(`job ${job.id} for release ${job.release_id}: ${result.ok ? "succeeded" : "failed"}`);
  return job.id;
}

/** The sweep: runs queued jobs until none is left (or `max`), for jobs whose machine never started. */
export async function sweep(deps: WorkerDeps, max = 50): Promise<number> {
  let ran = 0;
  while (ran < max && (await runOneJob(deps))) ran++;
  return ran;
}

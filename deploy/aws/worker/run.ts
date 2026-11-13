// The same rules and words as session E's worker (deploy/supabase/worker/run.ts); a test
// checks the words match. Session H later replaces both skeletons with one shared worker.
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
const TOO_LONG = "Processing took too long and was stopped. Please upload the masters again, or contact us if it keeps happening.";

/** How long one job may run before it counts as stuck. Default 4 hours (MC_JOB_TIME_LIMIT_MINUTES). */
export const DEFAULT_JOB_TIME_LIMIT_MS = 4 * 60 * 60 * 1000;

export interface WorkerDeps {
  database: Database;
  jobs: Jobs;
  process: ProcessRelease;
  /** A job running longer than this is stopped and reported as failed. */
  timeLimitMs?: number;
  log?: (message: string) => void;
}

/**
 * Runs one job: the one named, or else the oldest queued one. `api_job_started` claims it; it
 * returns false when the job is not queued (another task took it, or it already ran), and
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = deps.timeLimitMs ?? DEFAULT_JOB_TIME_LIMIT_MS;
  const tooLong = new Promise<"too_long">((resolve) => { timer = setTimeout(() => resolve("too_long"), limit); });
  try {
    const outcome = await Promise.race([deps.process({ jobId: job.id, releaseId: job.release_id }), tooLong]);
    if (outcome === "too_long") {
      // The processing step may still be running; the caller exits the task after this.
      log(`job ${job.id} passed its time limit of ${limit} ms`);
      result = { ok: false, message: TOO_LONG };
    } else {
      result = outcome;
    }
  } catch (error) {
    log(`job ${job.id} threw: ${(error as Error)?.stack ?? String(error)}`);
    result = { ok: false, message: CRASHED };
  } finally {
    clearTimeout(timer);
  }
  if (!result.ok && !result.message.trim()) result = { ok: false, message: CRASHED };
  await deps.jobs.reportResult(job.id, result);
  log(`job ${job.id} for release ${job.release_id}: ${result.ok ? "succeeded" : "failed"}`);
  return job.id;
}

/**
 * Jobs still `running` past the time limit: their task died or hung. Each is reported as a
 * plain-words failure through the normal result path, so the release moves to `failed` and the
 * artist can upload again. If the task reports later, api_apply_job_result ignores it (a
 * finished job is left alone). Returns the job ids it failed.
 */
export async function failStuckJobs(deps: WorkerDeps): Promise<string[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const limit = deps.timeLimitMs ?? DEFAULT_JOB_TIME_LIMIT_MS;
  const stuck = await deps.database.query<{ id: string }>(
    `select id from public.api_jobs
     where state = 'running' and started_at < now() - make_interval(secs => $1::double precision)
     order by seq limit 50`,
    [limit / 1000],
  );
  for (const { id } of stuck) {
    await deps.jobs.reportResult(id, { ok: false, message: TOO_LONG });
    log(`job ${id} was still running after ${limit} ms; reported it as failed`);
  }
  return stuck.map((j) => j.id);
}

/**
 * The hourly sweep: first fails stuck jobs, then runs queued jobs until none is left (or
 * `max`), for jobs whose task never started. Returns how many it ran.
 */
export async function sweep(deps: WorkerDeps, max = 50): Promise<number> {
  await failStuckJobs(deps);
  let ran = 0;
  while (ran < max && (await runOneJob(deps))) ran++;
  return ran;
}

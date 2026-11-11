export type JobKind = "process_release";

export interface JobRequest {
  kind: JobKind;
  releaseId: string;
}

export type JobResult =
  | { ok: true }
  /** `message` is plain words for the artist. */
  | { ok: false; message: string };

/**
 * Queue a job, report its result. The job id is a row in session B's jobs table, which ties it
 * to the release.
 */
export interface Jobs {
  enqueue(job: JobRequest): Promise<{ jobId: string }>;
  /**
   * Called by the worker. Each deployment's implementation passes the result to the shared
   * core function that applies it (session G), which moves the release state.
   */
  reportResult(jobId: string, result: JobResult): Promise<void>;
}

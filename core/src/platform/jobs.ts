export type JobKind = "process_release";

export interface JobRequest {
  kind: JobKind;
  releaseId: string;
}

export type JobResult =
  | { ok: true }
  /** `message` is plain words for the artist. */
  | { ok: false; message: string };

/** Queue a job, report its result. */
export interface Jobs {
  enqueue(job: JobRequest): Promise<{ jobId: string }>;
  /** Called by the worker. */
  reportResult(jobId: string, result: JobResult): Promise<void>;
}

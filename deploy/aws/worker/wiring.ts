// Session G's shared functions for the worker (core/src/handlers/), from the copy in _core/
// (scripts/copy-core.sh), because the image's build context is deploy/aws/.
import type { Database, Jobs, ObjectStorage } from "../src/core.ts";
import type { ApplyJobResult } from "../src/jobs.ts";
import { makeApplyJobResult, makeRequeueStuckReleases, makeRetryTakedownDeletes } from "../_core/handlers/index.ts";

/** The job result through api_apply_job_result: success or failure moves the release on. */
export function applyJobResultWith(database: Database): ApplyJobResult {
  return makeApplyJobResult({ database });
}

/**
 * The hourly sweep's part from session G, run before the worker's own sweep:
 *   - queues a job again for a release stuck in processing with no job (a confirm whose enqueue
 *     failed). The worker's sweep then runs it, here, because this task starts no other task;
 *   - deletes again the files of a takedown whose delete failed.
 */
export async function coreSweep(
  modules: { database: Database; jobs: Jobs; storage: ObjectStorage },
  log: (message: string) => void = (m) => console.log(m),
): Promise<void> {
  const requeued = await makeRequeueStuckReleases(modules, { log })();
  log(`requeued ${requeued.requeued.length} stuck releases (${requeued.failed.length} failed)`);
  const takedowns = await makeRetryTakedownDeletes(modules, { log })();
  log(`deleted the files of ${takedowns.deleted.length} takedowns (${takedowns.failed.length} failed)`);
}

// The worker on Fly Machines. One machine per job (MC_JOB_ID), started by Jobs.enqueue, or
// the hourly sweep (MC_WORKER_MODE=sweep): session G's part first (a job again for a release
// stuck in processing; files of a takedown whose delete failed), then it fails jobs running
// past the time limit (MC_JOB_TIME_LIMIT_MINUTES, default 240), then runs jobs whose machine
// never started. The processing step is session H's shared one (worker/src/, copied into
// _worker/ by scripts/copy-core.sh); it needs ffmpeg and ffprobe on PATH (the image has them).
//
//   node worker/main.ts
//
// Node 22.18 or newer runs the TypeScript as is. Settings come from Fly secrets: MC_DB_URL
// (session pooler or direct, as postgres), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createSupabaseModules } from "../src/modules.ts";
import { runOneJob, sweep } from "./run.ts";
import { makeProcessRelease } from "../_worker/index.ts";
import { applyJobResultWith, coreSweep } from "./wiring.ts";

const env = (name: string) => process.env[name];
// The job result needs the modules' database, so it is looked up when a result comes in.
const modules = createSupabaseModules(env, {
  applyJobResult: (jobId, result) => applyJobResultWith(modules.database)(jobId, result),
  poolSize: 2,
});
const minutes = Number(env("MC_JOB_TIME_LIMIT_MINUTES") || 0);
const deps = {
  database: modules.database,
  jobs: modules.jobs,
  process: makeProcessRelease({ database: modules.database, storage: modules.storage }),
  timeLimitMs: minutes > 0 ? minutes * 60_000 : undefined,
};

try {
  if (env("MC_WORKER_MODE") === "sweep") {
    await coreSweep(modules);
    console.log(`sweep ran ${await sweep(deps)} jobs`);
  } else {
    await runOneJob(deps, env("MC_JOB_ID") || undefined);
  }
} catch (error) {
  console.error((error as Error)?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await modules.database.close();
  // A job stopped at its time limit may still have work in flight: end the machine anyway.
  process.exit();
}

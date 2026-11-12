// The worker on Fly Machines. One machine per job (MC_JOB_ID), started by Jobs.enqueue, or
// the hourly sweep (MC_WORKER_MODE=sweep): it fails jobs running past the time limit
// (MC_JOB_TIME_LIMIT_MINUTES, default 240), then runs jobs whose machine never started.
//
//   node worker/main.ts
//
// Node 22.18 or newer runs the TypeScript as is. Settings come from Fly secrets: MC_DB_URL
// (session pooler or direct, as postgres), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createSupabaseModules } from "../src/modules.ts";
import { processingNotBuilt, runOneJob, sweep } from "./run.ts";
import { applyJobResult } from "./wiring.ts";

const env = (name: string) => process.env[name];
const modules = createSupabaseModules(env, { applyJobResult, poolSize: 2 });
const minutes = Number(env("MC_JOB_TIME_LIMIT_MINUTES") || 0);
const deps = {
  database: modules.database,
  jobs: modules.jobs,
  process: processingNotBuilt,
  timeLimitMs: minutes > 0 ? minutes * 60_000 : undefined,
};

try {
  if (env("MC_WORKER_MODE") === "sweep") {
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

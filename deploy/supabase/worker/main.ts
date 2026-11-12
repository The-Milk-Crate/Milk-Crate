// The worker on Fly Machines. One machine per job (MC_JOB_ID), started by Jobs.enqueue, or
// the hourly sweep (MC_WORKER_MODE=sweep) for jobs whose machine never started.
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
const deps = { database: modules.database, jobs: modules.jobs, process: processingNotBuilt };

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
}

// The worker on Fargate. One task per job (MC_JOB_ID), started by Jobs.enqueue, or the hourly
// sweep (MC_WORKER_MODE=sweep, started by EventBridge Scheduler): session G's part first (a job
// again for a release stuck in processing; files of a takedown whose delete failed), then it
// fails jobs running past the time limit (MC_JOB_TIME_LIMIT_MINUTES, default 240), then runs
// jobs whose task never started.
//
//   node worker/main.ts
//
// Node 22.18 or newer runs the TypeScript as is. Settings come from the task definition
// (infra/stack.ts): AWS_REGION, MC_DB_CLUSTER_ARN, MC_DB_SECRET_ARN, MC_DB_NAME, MC_BUCKET.
// Credentials come from the task role.
import { databaseFromEnv, workerStorageFromEnv } from "../src/modules.ts";
import { awsJobs } from "../src/jobs.ts";
import { processingNotBuilt, runOneJob, sweep } from "./run.ts";
import { applyJobResultWith, coreSweep } from "./wiring.ts";

const env = (name: string) => process.env[name];
const database = databaseFromEnv(env);
const jobs = awsJobs({ database, applyResult: applyJobResultWith(database) });
const minutes = Number(env("MC_JOB_TIME_LIMIT_MINUTES") || 0);
const deps = {
  database,
  jobs,
  process: processingNotBuilt,
  timeLimitMs: minutes > 0 ? minutes * 60_000 : undefined,
};

try {
  if (env("MC_WORKER_MODE") === "sweep") {
    await coreSweep({ database, jobs, storage: workerStorageFromEnv(env) });
    console.log(`sweep ran ${await sweep(deps)} jobs`);
  } else {
    await runOneJob(deps, env("MC_JOB_ID") || undefined);
  }
} catch (error) {
  console.error((error as Error)?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  // A job stopped at its time limit may still have work in flight: end the task anyway.
  process.exit();
}

// The worker on Fargate. One task per job (MC_JOB_ID), started by Jobs.enqueue, or the hourly
// sweep (MC_WORKER_MODE=sweep, started by EventBridge Scheduler): it fails jobs running past
// the time limit (MC_JOB_TIME_LIMIT_MINUTES, default 240), then runs jobs whose task never
// started.
//
//   node worker/main.ts
//
// Node 22.18 or newer runs the TypeScript as is. Settings come from the task definition
// (infra/stack.ts): AWS_REGION, MC_DB_CLUSTER_ARN, MC_DB_SECRET_ARN, MC_DB_NAME. Credentials
// come from the task role.
import { databaseFromEnv } from "../src/modules.ts";
import { awsJobs } from "../src/jobs.ts";
import { processingNotBuilt, runOneJob, sweep } from "./run.ts";
import { applyJobResult } from "./wiring.ts";

const env = (name: string) => process.env[name];
const database = databaseFromEnv(env);
const minutes = Number(env("MC_JOB_TIME_LIMIT_MINUTES") || 0);
const deps = {
  database,
  jobs: awsJobs({ database, applyResult: applyJobResult }),
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
  // A job stopped at its time limit may still have work in flight: end the task anyway.
  process.exit();
}

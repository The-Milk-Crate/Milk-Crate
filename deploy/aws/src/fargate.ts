import { RunTaskCommand } from "@aws-sdk/client-ecs";
import type { Sender } from "./aws.ts";

/** Starts a worker for one job. */
export interface WorkerStarter {
  startJob(jobId: string): Promise<void>;
}

export interface FargateWorkerOptions {
  /** An ECS client. */
  ecs: Sender;
  cluster: string;
  /** The worker's task definition (family, family:revision or ARN). */
  taskDefinition: string;
  /** The container name in the task definition. */
  container: string;
  /** Public subnets: the task reaches the Data API and S3 over its public IP (no NAT gateway). */
  subnets: string[];
  securityGroups: string[];
}

/**
 * One Fargate task per job, with MC_JOB_ID set. `clientToken` is the job id, so asking twice
 * for the same job starts one task (ECS keeps the token for a while), like session E's Fly
 * machine name. The worker's own claim (`api_job_started`) makes a second task a no-op anyway.
 */
export function fargateWorker(options: FargateWorkerOptions): WorkerStarter {
  return {
    async startJob(jobId: string): Promise<void> {
      const out = await options.ecs.send(
        new RunTaskCommand({
          cluster: options.cluster,
          taskDefinition: options.taskDefinition,
          launchType: "FARGATE",
          count: 1,
          clientToken: jobId,
          startedBy: `job-${jobId.slice(0, 30)}`,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: options.subnets,
              securityGroups: options.securityGroups,
              assignPublicIp: "ENABLED",
            },
          },
          overrides: {
            containerOverrides: [{ name: options.container, environment: [{ name: "MC_JOB_ID", value: jobId }] }],
          },
        }),
      );
      const failure = out.failures?.[0];
      if (failure || !out.tasks?.length) {
        throw new Error(`starting the worker on Fargate failed: ${failure?.reason ?? "no task started"} ${failure?.detail ?? ""}`.trim());
      }
    },
  };
}

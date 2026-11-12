/** Starts a worker machine for one job, through the Fly Machines API. */
export interface FlyMachinesOptions {
  /** The Fly app that holds the worker image and its secrets. */
  app: string;
  /** A Fly API token for that app (a deploy token is enough). */
  token: string;
  /** The worker image, such as registry.fly.io/<app>:phase0. */
  image: string;
  region?: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface WorkerStarter {
  startJob(jobId: string): Promise<void>;
}

export function flyMachines(options: FlyMachinesOptions): WorkerStarter {
  const base = (options.apiBase ?? "https://api.machines.dev").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  return {
    async startJob(jobId: string): Promise<void> {
      const response = await doFetch(`${base}/v1/apps/${encodeURIComponent(options.app)}/machines`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          // One machine per job: the name makes a second start of the same job a no-op.
          name: `job-${jobId}`,
          ...(options.region ? { region: options.region } : {}),
          config: {
            image: options.image,
            env: { MC_JOB_ID: jobId },
            auto_destroy: true,
            restart: { policy: "no" },
            guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
          },
        }),
      });
      if (response.ok) return;
      const text = await response.text().catch(() => "");
      // Fly refuses a name that is taken: that job's machine was already started.
      if (response.status === 409 || (response.status === 422 && /already exists|unique/i.test(text))) return;
      throw new Error(`starting the worker on Fly failed (${response.status}): ${text.slice(0, 200)}`);
    },
  };
}

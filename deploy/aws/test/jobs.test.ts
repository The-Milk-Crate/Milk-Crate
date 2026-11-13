import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunTaskCommand } from "@aws-sdk/client-ecs";
import type { Database, SqlValue } from "../src/core.ts";
import { awsJobs } from "../src/jobs.ts";
import { fargateWorker } from "../src/fargate.ts";
import { FakeAws } from "./fake-aws.ts";

const JOB = "44444444-4444-4444-8444-444444444444";
const REL = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  const calls: { sql: string; params: SqlValue[] }[] = [];
  const db: Database = {
    async query<Row>(sql: string, params: SqlValue[] = []) {
      calls.push({ sql, params });
      return [{ id: JOB }] as Row[];
    },
    async transaction(fn) { return fn(db); },
  };
  return { db, calls };
}

const worker = (ecs: FakeAws) =>
  fargateWorker({ ecs, cluster: "mc", taskDefinition: "arn:td", container: "worker", subnets: ["s1", "s2"], securityGroups: ["sg"] });

test("enqueue makes the row with api_create_job, then starts one Fargate task for the job", async () => {
  const { db, calls } = fakeDb();
  const ecs = new FakeAws().on(RunTaskCommand, () => ({ tasks: [{ taskArn: "t" }], failures: [] }));
  assert.deepEqual(await awsJobs({ database: db, worker: worker(ecs) }).enqueue({ kind: "process_release", releaseId: REL }), { jobId: JOB });
  assert.equal(calls[0].sql, "select public.api_create_job($1::uuid, $2::text) as id");
  assert.deepEqual(calls[0].params, [REL, "process_release"]);
  assert.deepEqual(ecs.inputs(RunTaskCommand)[0], {
    cluster: "mc",
    taskDefinition: "arn:td",
    launchType: "FARGATE",
    count: 1,
    clientToken: JOB,
    startedBy: `job-${JOB.slice(0, 30)}`,
    networkConfiguration: { awsvpcConfiguration: { subnets: ["s1", "s2"], securityGroups: ["sg"], assignPublicIp: "ENABLED" } },
    overrides: { containerOverrides: [{ name: "worker", environment: [{ name: "MC_JOB_ID", value: JOB }] }] },
  });
});

test("if the task cannot start, enqueue still returns the job id (the row stays queued for the sweep)", async () => {
  for (const reply of [
    () => { throw new Error("ECS is down"); },
    () => ({ tasks: [], failures: [{ reason: "RESOURCE:ENI", detail: "no capacity" }] }),
  ]) {
    const { db } = fakeDb();
    const logs: string[] = [];
    const ecs = new FakeAws().on(RunTaskCommand, reply);
    const out = await awsJobs({ database: db, worker: worker(ecs), log: (m) => logs.push(m) }).enqueue({ kind: "process_release", releaseId: REL });
    assert.equal(out.jobId, JOB);
    assert.match(logs[0], /is queued, but the worker did not start/);
  }
});

test("reportResult goes to session G's function, and says plainly that it is not wired yet", async () => {
  const { db } = fakeDb();
  await assert.rejects(awsJobs({ database: db }).reportResult(JOB, { ok: true }), /waiting on session G/);
  const seen: unknown[] = [];
  await awsJobs({ database: db, applyResult: async (id, r) => { seen.push([id, r]); } }).reportResult(JOB, { ok: false, message: "x" });
  assert.deepEqual(seen, [[JOB, { ok: false, message: "x" }]]);
});

test("the worker skeleton uses session E's rules and words", () => {
  const mine = readFileSync(join(import.meta.dirname, "../worker/run.ts"), "utf8");
  const theirs = readFileSync(join(import.meta.dirname, "../../supabase/worker/run.ts"), "utf8");
  for (const words of [
    "Processing is not set up yet, so this release cannot move on. Nothing is wrong with your files.",
    "Processing stopped before it finished. Please upload the masters again, or contact us if it keeps happening.",
    "Processing took too long and was stopped. Please upload the masters again, or contact us if it keeps happening.",
    "DEFAULT_JOB_TIME_LIMIT_MS = 4 * 60 * 60 * 1000",
  ]) {
    assert.ok(theirs.includes(words), `session E has: ${words}`);
    assert.ok(mine.includes(words), `session F has: ${words}`);
  }
  // Code identical apart from comments.
  const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  assert.equal(code(mine), code(theirs));
});

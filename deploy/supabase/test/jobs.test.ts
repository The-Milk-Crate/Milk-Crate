import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ClosableDatabase } from "../src/database.ts";
import type { Database, JobResult } from "../src/core.ts";
import { flyMachines } from "../src/fly.ts";
import { supabaseJobs, type ApplyJobResult } from "../src/jobs.ts";
import { processingNotBuilt, runOneJob, sweep } from "../worker/run.ts";
import { fakeFetch, NEEDS_DB, newRelease, processingRelease, releaseState, testDb } from "./helpers.ts";

const fly = (status = 201, body = "{}") =>
  fakeFetch(() => new Response(body, { status, headers: { "content-type": "application/json" } }));

describe("Fly Machines (mocked at the HTTP edge)", () => {
  test("starts one machine for the job, with the job id and nothing secret", async () => {
    const f = fly();
    await flyMachines({ app: "mc-worker", token: "fly-token", image: "registry.fly.io/mc-worker:phase0", region: "iad", fetch: f.fetch }).startJob("job-1");
    assert.equal(f.calls.length, 1);
    const req = f.calls[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "https://api.machines.dev/v1/apps/mc-worker/machines");
    assert.equal(req.headers.get("authorization"), "Bearer fly-token");
    const body = await req.json();
    assert.equal(body.name, "job-job-1");
    assert.equal(body.region, "iad");
    assert.equal(body.config.image, "registry.fly.io/mc-worker:phase0");
    assert.deepEqual(body.config.env, { MC_JOB_ID: "job-1" });
    assert.equal(body.config.auto_destroy, true);
    assert.deepEqual(body.config.restart, { policy: "no" });
  });

  test("a second start of the same job is not an error; other failures are", async () => {
    await flyMachines({ app: "a", token: "t", image: "i", fetch: fly(409, "conflict").fetch }).startJob("j");
    await flyMachines({ app: "a", token: "t", image: "i", fetch: fly(422, '{"error":"machine name already exists"}').fetch }).startJob("j");
    await assert.rejects(flyMachines({ app: "a", token: "t", image: "i", fetch: fly(500, "down").fetch }).startJob("j"), /\(500\)/);
  });
});

describe("Jobs without a database", () => {
  const fakeDb = (id: string): Database & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      async query<Row>(sql: string, params: unknown[] = []) { calls.push([sql, params]); return [{ id }] as Row[]; },
      async transaction<T>(fn: (tx: Database) => Promise<T>) { return fn(this); },
    } as Database & { calls: unknown[][] };
  };

  test("enqueue uses api_create_job(release, 'process_release')", async () => {
    const db = fakeDb("j1");
    const { jobId } = await supabaseJobs({ database: db }).enqueue({ kind: "process_release", releaseId: "r1" });
    assert.equal(jobId, "j1");
    assert.deepEqual(db.calls, [["select public.api_create_job($1::uuid, $2::text) as id", ["r1", "process_release"]]]);
  });

  test("if Fly cannot be reached the job stays queued for the sweep, and enqueue still answers", async () => {
    const logs: string[] = [];
    const worker = flyMachines({ app: "a", token: "t", image: "i", fetch: fly(503, "unavailable").fetch });
    const { jobId } = await supabaseJobs({ database: fakeDb("j2"), worker, log: (m) => logs.push(m) }).enqueue({ kind: "process_release", releaseId: "r" });
    assert.equal(jobId, "j2");
    assert.match(logs[0], /job j2 is queued, but the worker did not start/);
  });

  test("reportResult passes the result to session G's function, and refuses until it is wired", async () => {
    const seen: [string, JobResult][] = [];
    const applyResult: ApplyJobResult = async (id, r) => { seen.push([id, r]); };
    await supabaseJobs({ database: fakeDb("x"), applyResult }).reportResult("j", { ok: false, message: "Bad file." });
    assert.deepEqual(seen, [["j", { ok: false, message: "Bad file." }]]);
    await assert.rejects(supabaseJobs({ database: fakeDb("x") }).reportResult("j", { ok: true }), /waiting on session G/);
  });
});

describe("Jobs and the worker skeleton (local Postgres)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  before(() => { db = testDb(); });
  after(() => db.close());

  // Test only: stands in for session G's job-result function, which applies the result
  // with api_apply_job_result. The real wiring waits on G.
  const applyResult: ApplyJobResult = async (jobId, r) => {
    await db.query("select * from public.api_apply_job_result($1::uuid, $2::boolean, $3::text)", [jobId, r.ok, r.ok ? null : r.message]);
  };
  const jobState = async (id: string) =>
    (await db.query<{ state: string; failure_message: string | null }>("select state, failure_message from public.api_jobs where id = $1::uuid", [id]))[0];

  test("enqueue needs a processing release", async () => {
    const r = await newRelease(db);
    await assert.rejects(supabaseJobs({ database: db }).enqueue({ kind: "process_release", releaseId: r.releaseId }), (e: { code?: string }) => e.code === "MC409");
  });

  test("enqueue → Fly start → worker claims it → success moves the release to awaiting_splits", async () => {
    const r = await processingRelease(db);
    const f = fly();
    const jobs = supabaseJobs({ database: db, worker: flyMachines({ app: "a", token: "t", image: "i", fetch: f.fetch }), applyResult });
    const { jobId } = await jobs.enqueue({ kind: "process_release", releaseId: r.releaseId });
    assert.equal((await jobState(jobId)).state, "queued");
    assert.deepEqual((await f.calls[0].json()).config.env, { MC_JOB_ID: jobId });

    const seen: string[] = [];
    const ran = await runOneJob({ database: db, jobs, process: async (j) => { seen.push(j.releaseId); return { ok: true }; }, log: () => {} }, jobId);
    assert.equal(ran, jobId);
    assert.deepEqual(seen, [r.releaseId]);
    assert.equal((await jobState(jobId)).state, "succeeded");
    assert.equal((await releaseState(db, r.releaseId)).state, "awaiting_splits");

    // A second machine for the same job does nothing.
    assert.equal(await runOneJob({ database: db, jobs, process: async () => { throw new Error("must not run"); }, log: () => {} }, jobId), null);
  });

  test("a plain-words failure moves the release to failed with that reason", async () => {
    const r = await processingRelease(db);
    const jobs = supabaseJobs({ database: db, applyResult });
    const { jobId } = await jobs.enqueue({ kind: "process_release", releaseId: r.releaseId });
    await runOneJob({ database: db, jobs, process: async () => ({ ok: false, message: "Track 1 is not a readable WAV file." }), log: () => {} }, jobId);
    assert.deepEqual(await jobState(jobId), { state: "failed", failure_message: "Track 1 is not a readable WAV file." });
    assert.deepEqual(await releaseState(db, r.releaseId), { state: "failed", failure_reason: "Track 1 is not a readable WAV file." });
  });

  test("a crash is reported in plain words, not as a stack", async () => {
    const r = await processingRelease(db);
    const jobs = supabaseJobs({ database: db, applyResult });
    const { jobId } = await jobs.enqueue({ kind: "process_release", releaseId: r.releaseId });
    await runOneJob({ database: db, jobs, process: async () => { throw new TypeError("x is undefined"); }, log: () => {} }, jobId);
    const s = await releaseState(db, r.releaseId);
    assert.equal(s.state, "failed");
    assert.match(s.failure_reason!, /^Processing stopped before it finished\./);
    assert.doesNotMatch(s.failure_reason!, /undefined/);
  });

  test("the skeleton's processing is not built: it fails the release plainly and touches no file", async () => {
    const r = await processingRelease(db);
    const jobs = supabaseJobs({ database: db, applyResult });
    const { jobId } = await jobs.enqueue({ kind: "process_release", releaseId: r.releaseId });
    await runOneJob({ database: db, jobs, process: processingNotBuilt, log: () => {} }, jobId);
    assert.match((await releaseState(db, r.releaseId)).failure_reason!, /^Processing is not set up yet/);
  });

  test("the sweep runs queued jobs whose machine never started", async () => {
    await db.query("update public.api_jobs set state = 'failed', failure_message = 'test cleanup', finished_at = now(), started_at = coalesce(started_at, now()) where state = 'queued'");
    const a = await processingRelease(db);
    const b = await processingRelease(db);
    const jobs = supabaseJobs({ database: db, applyResult });
    await jobs.enqueue({ kind: "process_release", releaseId: a.releaseId });
    await jobs.enqueue({ kind: "process_release", releaseId: b.releaseId });
    assert.equal(await sweep({ database: db, jobs, process: async () => ({ ok: true }), log: () => {} }), 2);
    assert.equal((await releaseState(db, a.releaseId)).state, "awaiting_splits");
    assert.equal((await releaseState(db, b.releaseId)).state, "awaiting_splits");
  });
});

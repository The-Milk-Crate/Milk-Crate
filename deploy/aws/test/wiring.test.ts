// The worker's wiring to session G's shared functions, over the Data API stand-in on local
// Postgres: the job result moves the release, and the sweep's part requeues a stuck release and
// deletes a takedown's leftover files.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Database, ObjectStorage } from "../src/core.ts";
import { awsJobs } from "../src/jobs.ts";
import { runOneJob } from "../worker/run.ts";
import { applyJobResultWith, coreSweep } from "../worker/wiring.ts";
import { NEEDS_DB, processingRelease, testDb } from "./helpers.ts";

describe("worker wiring to session G (Data API stand-in)", { skip: NEEDS_DB }, () => {
  let t: ReturnType<typeof testDb>;
  let db: Database;
  before(() => {
    t = testDb();
    db = t.db;
  });
  after(() => t.close());
  const state = async (id: string) =>
    (await db.query<{ state: string; failure_reason: string | null }>("select state, failure_reason from public.api_releases where id = $1::uuid", [id]))[0];

  test("a job's result moves the release through G's makeApplyJobResult", async () => {
    const jobs = awsJobs({ database: db, applyResult: applyJobResultWith(db) });
    const ok = await processingRelease(db);
    const { jobId } = await jobs.enqueue({ kind: "process_release", releaseId: ok.releaseId });
    await runOneJob({ database: db, jobs, process: async () => ({ ok: true }), log: () => {} }, jobId);
    assert.equal((await state(ok.releaseId)).state, "awaiting_splits");

    const bad = await processingRelease(db);
    const second = await jobs.enqueue({ kind: "process_release", releaseId: bad.releaseId });
    await runOneJob({ database: db, jobs, process: async () => ({ ok: false, message: "The file is not a WAV." }), log: () => {} }, second.jobId);
    assert.deepEqual(await state(bad.releaseId), { state: "failed", failure_reason: "The file is not a WAV." });
  });

  test("the sweep's part requeues a release stuck in processing and retries a takedown's deletes", async () => {
    const jobs = awsJobs({ database: db, applyResult: applyJobResultWith(db) });
    const stuck = await processingRelease(db);
    // Stuck for an hour with no job (the touch trigger is off for this one update).
    await db.transaction(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query("update public.api_releases set updated_at = now() - interval '1 hour' where id = $1::uuid", [stuck.releaseId]);
    });
    // A takedown whose delete failed, an hour ago.
    const [{ id: adminId }] = await db.query<{ id: string }>(
      "insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'administrator') returning user_id::text as id",
    );
    const down = await processingRelease(db);
    const [{ audit_id }] = await db.query<{ audit_id: string }>(
      "select audit_id::text as audit_id from public.api_takedown_release($1::uuid, $2::uuid, 'Test.')",
      [down.releaseId, adminId],
    );
    await db.query("update public.api_audit_log set created_at = now() - interval '1 hour' where id = $1::uuid", [audit_id]);

    const deleted: string[] = [];
    const storage = { delete: async (prefix: string) => { deleted.push(prefix); } } as unknown as ObjectStorage;
    const logs: string[] = [];
    await coreSweep({ database: db, jobs, storage }, (m) => logs.push(m));

    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from public.api_jobs where release_id = $1::uuid and state = 'queued'", [stuck.releaseId]);
    assert.equal(n, 1, "the stuck release has a queued job for the worker's sweep to run");
    assert.deepEqual(deleted, [
      `masters/${down.artistId}/${down.releaseId}/`,
      `streams/${down.artistId}/${down.releaseId}/`,
      `art/${down.artistId}/${down.releaseId}/`,
    ]);
    const isDone = async () =>
      (await db.query<{ done: boolean }>("select files_deleted_at is not null as done from public.api_audit_log where id = $1::uuid", [audit_id]))[0].done;
    assert.equal(await isDone(), false, "an hour on: deleted, but the late pass waits for 2 hours");

    // The late pass, 2 hours or more after the takedown, deletes once more and marks it done.
    await db.query("update public.api_audit_log set created_at = now() - interval '3 hours' where id = $1::uuid", [audit_id]);
    deleted.length = 0;
    await coreSweep({ database: db, jobs, storage }, (m) => logs.push(m));
    assert.equal(deleted.length, 3);
    assert.equal(await isDone(), true);
    assert.ok(logs.some((l) => /requeued [1-9]/.test(l)));
  });
});

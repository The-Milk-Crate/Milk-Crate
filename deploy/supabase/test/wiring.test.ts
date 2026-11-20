// Session G's code wired into this deployment: the one `api` Edge Function (router), and the
// worker's job result and sweep part, against local Postgres.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { Modules, ObjectStorage } from "../src/core.ts";
import { edgeFunctions } from "../src/functions.ts";
import { supabaseJobs } from "../src/jobs.ts";
import { runOneJob } from "../worker/run.ts";
import { applyJobResultWith, coreSweep } from "../worker/wiring.ts";
import { router } from "../supabase/functions/_core/handlers/index.ts";
import { NEEDS_DB, processingRelease, releaseState, testDb } from "./helpers.ts";
import type { ClosableDatabase } from "../src/database.ts";

describe("the api Edge Function", () => {
  test("is the only entry point, and serves session G's router on every path", () => {
    const dir = new URL("../supabase/functions/", import.meta.url);
    const entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
    assert.deepEqual(entries, ["api"]);
    const source = readFileSync(new URL("api/index.ts", dir), "utf8");
    assert.match(source, /import \{ router \} from "\.\.\/_core\/handlers\/index\.ts";/);
    assert.match(source, /serveOperation\("\*", router\);/);
  });

  test("the router answers through the adapter with the contract's paths", async () => {
    let handler: ((r: Request) => Response | Promise<Response>) | undefined;
    const noCaller = { identity: { whoIs: async () => null } } as unknown as Modules;
    edgeFunctions({ serve: (h) => { handler = h; } }).handle("*", router, noCaller);
    await new Promise((r) => setTimeout(r, 0));
    const release = await handler!(new Request("http://edge/functions/v1/api/v1/releases/22222222-2222-4222-8222-222222222222"));
    assert.equal(release.status, 401, "getRelease ran and asked for a token");
    assert.equal((await release.json()).code, "unauthorized");
    const none = await handler!(new Request("http://edge/api/v1/nothing"));
    assert.equal(none.status, 404);
    assert.equal((await none.json()).code, "not_found");
  });
});

describe("worker wiring to session G (local Postgres)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  before(() => {
    db = testDb();
  });
  after(() => db.close());

  test("a job's result moves the release through G's makeApplyJobResult", async () => {
    const jobs = supabaseJobs({ database: db, applyResult: applyJobResultWith(db) });
    const ok = await processingRelease(db);
    const { jobId } = await jobs.enqueue({ kind: "process_release", releaseId: ok.releaseId });
    await runOneJob({ database: db, jobs, process: async () => ({ ok: true }), log: () => {} }, jobId);
    assert.equal((await releaseState(db, ok.releaseId)).state, "awaiting_splits");

    const bad = await processingRelease(db);
    const second = await jobs.enqueue({ kind: "process_release", releaseId: bad.releaseId });
    await runOneJob({ database: db, jobs, process: async () => ({ ok: false, message: "The file is not a WAV." }), log: () => {} }, second.jobId);
    assert.deepEqual(await releaseState(db, bad.releaseId), { state: "failed", failure_reason: "The file is not a WAV." });
  });

  test("the sweep's part requeues a release stuck in processing and retries a takedown's deletes", async () => {
    const jobs = supabaseJobs({ database: db, applyResult: applyJobResultWith(db) });
    const stuck = await processingRelease(db);
    await db.transaction(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query("update public.api_releases set updated_at = now() - interval '1 hour' where id = $1::uuid", [stuck.releaseId]);
    });
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
    await coreSweep({ database: db, jobs, storage }, () => {});

    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from public.api_jobs where release_id = $1::uuid and state = 'queued'", [stuck.releaseId]);
    assert.equal(n, 1);
    assert.deepEqual(deleted, [
      `masters/${down.artistId}/${down.releaseId}/`,
      `streams/${down.artistId}/${down.releaseId}/`,
      `art/${down.artistId}/${down.releaseId}/`,
    ]);
    const [{ done }] = await db.query<{ done: boolean }>("select files_deleted_at is not null as done from public.api_audit_log where id = $1::uuid", [audit_id]);
    assert.equal(done, true);
  });
});

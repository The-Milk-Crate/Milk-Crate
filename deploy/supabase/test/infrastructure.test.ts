import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ClosableDatabase } from "../src/database.ts";
import { confirmDeployment, HOOK_URI, supabaseInfrastructure } from "../src/infrastructure.ts";
import { fakeFetch, NEEDS_DB, testDb } from "./helpers.ts";

function apis(auth: Record<string, unknown>, storage: Record<string, unknown>, flyStatus = 200) {
  return fakeFetch((req) => {
    const u = new URL(req.url);
    if (u.host === "api.supabase.com" && u.pathname === "/v1/projects/abcd/config/auth") return Response.json(auth);
    if (u.host === "api.supabase.com" && u.pathname === "/v1/projects/abcd/config/storage") return Response.json(storage);
    if (u.host === "api.machines.dev" && u.pathname === "/v1/apps/mc-worker") return new Response("{}", { status: flyStatus });
    return new Response("no", { status: 404 });
  });
}
const goodAuth = { hook_custom_access_token_enabled: true, hook_custom_access_token_uri: HOOK_URI, jwt_exp: 3600 };
const goodStorage = { fileSizeLimit: 5368709120 };

describe("Infrastructure", () => {
  test("standUp and tearDown run the scripts", async () => {
    const ran: string[] = [];
    const infra = supabaseInfrastructure({ run: async (s, a) => { ran.push([s, ...a].join(" ")); }, confirm: async () => ({ ok: true, problems: [] }), tearDownArgs: ["--yes"] });
    await infra.standUp();
    await infra.tearDown();
    assert.deepEqual(ran, ["scripts/stand-up.sh", "scripts/tear-down.sh --yes"]);
    assert.deepEqual(await infra.confirm(), { ok: true, problems: [] });
  });
});

describe("Infrastructure.confirm (local Postgres after the stand-up SQL, APIs mocked)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  before(() => { db = testDb(); });
  after(() => db.close());
  const run = (f: ReturnType<typeof apis>) =>
    confirmDeployment({ database: db, projectRef: "abcd", accessToken: "sbp_test", flyApp: "mc-worker", flyToken: "fly", fetch: f.fetch });

  test("a correct stand-up has no problems", async () => {
    const f = apis(goodAuth, goodStorage);
    assert.deepEqual(await run(f), { ok: true, problems: [] });
    assert.equal(f.calls[0].headers.get("authorization"), "Bearer sbp_test");
  });

  test("finds the hook off, a short token life, the 50 MB Free-plan limit and a missing Fly app", async () => {
    const r = await run(apis({ hook_custom_access_token_enabled: false, hook_custom_access_token_uri: null, jwt_exp: 7200 }, { fileSizeLimit: 52428800 }, 404));
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, [
      "the custom access token hook is off",
      "the access token hook points at null",
      "token life is 7200 seconds, expected 3600",
      "the project's file size limit is 52428800 bytes; 5 GiB masters need 5368709120 (Pro plan or higher)",
      "Fly app mc-worker returned 404",
    ]);
  });

  test("finds the daily schedule sweep missing", async () => {
    await db.query("update cron.job set active = false where jobname = 'mc_schedule_sweep'");
    try {
      assert.deepEqual((await run(apis(goodAuth, goodStorage))).problems, ["the daily schedule sweep (pg_cron job mc_schedule_sweep) is missing"]);
    } finally {
      await db.query("update cron.job set active = true where jobname = 'mc_schedule_sweep'");
    }
  });

  test("finds a client grant that came back, and a public bucket", async () => {
    await db.query("grant select on public.api_jobs to anon");
    await db.query("grant execute on function public.api_takedown_release(uuid, uuid, text) to authenticated");
    await db.query("update storage.buckets set public = true where id = 'mc-art'");
    try {
      const r = await run(apis(goodAuth, goodStorage));
      assert.deepEqual(r.problems, ["anon can reach api_jobs", "authenticated can run api_takedown_release", "bucket mc-art is public"]);
    } finally {
      await db.query("revoke select on public.api_jobs from anon");
      await db.query("revoke execute on function public.api_takedown_release(uuid, uuid, text) from authenticated");
      await db.query("update storage.buckets set public = false where id = 'mc-art'");
    }
  });
});

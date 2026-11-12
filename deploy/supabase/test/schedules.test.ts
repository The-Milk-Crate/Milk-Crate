import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ClosableDatabase } from "../src/database.ts";
import { DatabaseError } from "../src/database.ts";
import { supabaseSchedules } from "../src/schedules.ts";
import { NEEDS_DB, releaseState, scheduledRelease, testDb } from "./helpers.ts";

describe("Schedules (pg_cron, local Postgres with a pg_cron stand-in)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  before(() => { db = testDb(); });
  after(() => db.close());

  const job = async (name: string) =>
    (await db.query<{ schedule: string; command: string }>("select schedule, command from cron.job where jobname = $1::text", [`mc_schedule:${name}`]))[0];
  /** Run the job's command as pg_cron would. */
  const fire = async (name: string) => {
    const j = await job(name);
    assert.ok(j, `pg_cron job for ${name}`);
    const [row] = await db.query<{ api_schedule_fire: string }>(j.command);
    return row.api_schedule_fire;
  };

  test("schedules api_release_go_live with p_release_id for the minute of the release date (UTC)", async () => {
    const r = await scheduledRelease(db);
    const name = `go-live:${r.releaseId}`;
    const at = new Date(Date.UTC(2031, 2, 14, 0, 0, 0));
    await supabaseSchedules(db).runSqlFunctionAt({ name, fn: "api_release_go_live", args: { p_release_id: r.releaseId }, at });
    const j = await job(name);
    assert.equal(j.schedule, "0 0 14 3 *");
    assert.equal(j.command, `select public.api_schedule_fire('${name}')`);
    const [row] = await db.query<{ fn: string; args: unknown }>("select fn, args from public.api_schedules where name = $1::text", [name]);
    assert.deepEqual(row, { fn: "api_release_go_live", args: { p_release_id: r.releaseId } });
    // Not due yet: nothing happens and the job stays.
    assert.equal(await fire(name), "not_due");
    assert.equal((await releaseState(db, r.releaseId)).state, "scheduled");
    assert.ok(await job(name));
  });

  test("a time with seconds rounds up to the next minute", async () => {
    const name = "round-up";
    await supabaseSchedules(db).runSqlFunctionAt({ name, fn: "api_release_go_live", args: { p_release_id: crypto.randomUUID() }, at: new Date(Date.UTC(2031, 0, 31, 23, 59, 30)) });
    assert.equal((await job(name)).schedule, "0 0 1 2 *");
  });

  test("when due it runs once: scheduled moves to live, the row and the pg_cron job are removed", async () => {
    const r = await scheduledRelease(db);
    const name = `go-live:${r.releaseId}`;
    await supabaseSchedules(db).runSqlFunctionAt({ name, fn: "api_release_go_live", args: { p_release_id: r.releaseId }, at: new Date(Date.now() - 1000) });
    assert.equal((await job(name)).schedule, "* * * * *");
    assert.equal(await fire(name), "ran");
    assert.equal((await releaseState(db, r.releaseId)).state, "live");
    assert.equal(await job(name), undefined);
    const rows = await db.query("select 1 from public.api_schedules where name = $1::text", [name]);
    assert.equal(rows.length, 0);
    // Fired again (a late duplicate): nothing to do.
    assert.equal((await db.query<{ v: string }>("select public.api_schedule_fire($1::text) as v", [name]))[0].v, "none");
  });

  test("a run after a takedown is harmless", async () => {
    const r = await scheduledRelease(db);
    const name = `go-live:${r.releaseId}`;
    await supabaseSchedules(db).runSqlFunctionAt({ name, fn: "api_release_go_live", args: { p_release_id: r.releaseId }, at: new Date(Date.now() - 1000) });
    await db.query(
      "insert into public.api_accounts (user_id, account_type) values ('00000000-0000-0000-0000-00000000ad01', 'administrator') on conflict do nothing",
    );
    await db.query("select * from public.api_takedown_release($1::uuid, '00000000-0000-0000-0000-00000000ad01', 'test')", [r.releaseId]);
    assert.equal(await fire(name), "ran");
    assert.equal((await releaseState(db, r.releaseId)).state, "taken_down");
  });

  test("setting the same name again replaces the earlier run", async () => {
    const a = await scheduledRelease(db);
    const b = await scheduledRelease(db);
    const s = supabaseSchedules(db);
    await s.runSqlFunctionAt({ name: "same", fn: "api_release_go_live", args: { p_release_id: a.releaseId }, at: new Date(Date.UTC(2032, 5, 1)) });
    await s.runSqlFunctionAt({ name: "same", fn: "api_release_go_live", args: { p_release_id: b.releaseId }, at: new Date(Date.now() - 1000) });
    const jobs = await db.query("select 1 from cron.job where jobname = 'mc_schedule:same'");
    assert.equal(jobs.length, 1);
    assert.equal(await fire("same"), "ran");
    assert.equal((await releaseState(db, a.releaseId)).state, "scheduled");
    assert.equal((await releaseState(db, b.releaseId)).state, "live");
  });

  test("a function that raises keeps its row with the error and removes the job", async () => {
    await supabaseSchedules(db).runSqlFunctionAt({ name: "fails", fn: "api_create_job", args: { p_release_id: crypto.randomUUID(), p_kind: "process_release" }, at: new Date(Date.now() - 1000) });
    assert.equal(await fire("fails"), "failed");
    const [row] = await db.query<{ last_error: string }>("select last_error from public.api_schedules where name = 'fails'");
    assert.match(row.last_error, /^MC404: not_found/);
    assert.equal(await job("fails"), undefined);
  });

  test("only existing public api_ functions and their own argument names", async () => {
    const s = supabaseSchedules(db);
    const at = new Date(Date.UTC(2033, 0, 1));
    await assert.rejects(s.runSqlFunctionAt({ name: "x", fn: "pg_sleep", at }), /only public api_ functions/);
    await assert.rejects(s.runSqlFunctionAt({ name: "x", fn: "api_no_such_fn", at }), (e: unknown) => e instanceof DatabaseError && e.code === "MC422");
    await assert.rejects(
      s.runSqlFunctionAt({ name: "x", fn: "api_release_go_live", args: { p_other: "1" }, at }),
      (e: unknown) => e instanceof DatabaseError && e.code === "MC422" && /has no argument p_other/.test(e.message),
    );
    await assert.rejects(s.runSqlFunctionAt({ name: "bad name'", fn: "api_release_go_live", at }), /bad schedule name/);
  });

  test("clients cannot reach the schedule table or functions", async () => {
    const [row] = await db.query<Record<string, boolean>>(
      `select has_table_privilege('authenticated', 'public.api_schedules', 'select, insert') as t,
              has_function_privilege('authenticated', 'public.api_schedule_set(text, text, jsonb, timestamptz)', 'execute') as s,
              has_function_privilege('anon', 'public.api_schedule_fire(text)', 'execute') as f,
              (select relrowsecurity from pg_class where oid = 'public.api_schedules'::regclass) as rls`,
    );
    assert.deepEqual(row, { t: false, s: false, f: false, rls: true });
  });
});

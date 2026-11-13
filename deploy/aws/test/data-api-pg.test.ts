// The AWS modules against session B's real SQL: a fake Data API over the throwaway Postgres
// from test/run.sh (whose migrations were applied through the stand-up's Data API path).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { RunTaskCommand } from "@aws-sdk/client-ecs";
import { CreateScheduleCommand, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteObjectsCommand, ListMultipartUploadsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type pg from "pg";
import type { Database, JobResult } from "../src/core.ts";
import { DatabaseError } from "../src/database.ts";
import { awsJobs, type ApplyJobResult } from "../src/jobs.ts";
import { fargateWorker } from "../src/fargate.ts";
import { eventBridgeSchedules } from "../src/schedules.ts";
import { postConfirmation, syncAccounts } from "../src/accounts.ts";
import { s3Storage } from "../src/storage.ts";
import { failStuckJobs, processingNotBuilt, runOneJob, sweep } from "../worker/run.ts";
import { FakeAws, awsError } from "./fake-aws.ts";
import type { FakeDataApi } from "./fake-data-api.ts";
import { NEEDS_DB, admin, newRelease, processingRelease, scheduledRelease, sessionEShape, testDb } from "./helpers.ts";

describe("Database over the Data API (fake Data API on local Postgres)", { skip: NEEDS_DB }, () => {
  let db: Database;
  let api: FakeDataApi;
  let close: () => Promise<void>;
  let shapeE: pg.Pool;
  before(() => {
    ({ db, api, close } = testDb());
    shapeE = sessionEShape();
  });
  after(async () => {
    await close();
    await shapeE.end();
  });

  /** The same SQL through the Data API path and read as session E reads it: the same rows. */
  async function sameAsE(sql: string, params: (string | number | boolean | null)[]) {
    const mine = await db.query(sql, params);
    const theirs = (await shapeE.query(sql, params)).rows;
    assert.deepEqual(mine, theirs, sql);
    return mine;
  }

  test("parameters travel as values, never as SQL text", async () => {
    const evil = "x'); drop table public.api_jobs; --";
    const [row] = await db.query<{ v: string }>("select $1::text as v", [evil]);
    assert.equal(row.v, evil);
    const [still] = await db.query<{ ok: boolean }>("select to_regclass('public.api_jobs') is not null as ok");
    assert.equal(still.ok, true);
  });

  test("numbers, booleans, null, dates and JSON: the same values session E's test expects", async () => {
    const at = new Date("2026-11-12T10:20:30.456Z");
    const [row] = await db.query<Record<string, unknown>>(
      "select $1::int + 1 as n, $2::boolean as b, $3::text is null as isnull, $4::timestamptz as t, $5::jsonb ->> 'k' as k, jsonb_array_length($6::jsonb) as len",
      [41, true, null, at, { k: "v" }, ["a", "b"]],
    );
    assert.deepEqual(row, { n: 42, b: true, isnull: true, t: "2026-11-12 10:20:30.456+00", k: "v", len: 2 });
    const [r2] = await db.query<Record<string, unknown>>(
      "select '2026-01-02 03:04:05.123456+00'::timestamptz as ts, '2026-01-02'::date as d, 12.50::numeric as n, 5368709120::bigint as big, '{\"a\":1}'::jsonb as j",
    );
    assert.deepEqual(r2, { ts: "2026-01-02 03:04:05.123456+00", d: "2026-01-02", n: "12.50", big: "5368709120", j: { a: 1 } });
  });

  test("not matched with session E: a bigint above 2^53 loses digits on the Data API (cast to text in the SQL)", async () => {
    // The Data API sends a bigint as a JSON number (longValue), so past 2^53 it is not exact.
    // Session B's bigints (job seq, sizes up to 5 GiB) stay far below that. Where an exact large
    // bigint matters, cast it in the SQL: `::text`.
    const [row] = await db.query<Record<string, unknown>>("select 9007199254740993::bigint as big, 9007199254740993::bigint::text as exact");
    assert.equal(row.big, "9007199254740992");
    assert.equal(row.exact, "9007199254740993");
  });

  test("session B's functions return the same shapes as on session E", async () => {
    const r = await processingRelease(db);
    const caller = r.ownerId;
    // listReleases: uuid, text, date, int, bool, timestamptz (the keyset cursor).
    const page = await sameAsE("select * from public.api_list_releases($1::uuid, null, 25, null, null)", [caller]);
    assert.equal(page.length, 1);
    assert.match((page[0] as { created_at: string }).created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/);
    // The cursor works when sent back exactly as returned.
    const p = page[0] as { created_at: string; id: string };
    const next = await db.query("select * from public.api_list_releases($1::uuid, null, 25, $2::timestamptz, $3::uuid)", [caller, p.created_at, p.id]);
    assert.deepEqual(next, []);
    // Rights: numeric percent as text.
    await db.query(
      "insert into public.api_parties (release_id, side, role, name, percent, is_owner) values ($1::uuid, 'recording', 'artist', 'Me', 33.33, true)",
      [r.releaseId],
    );
    const parties = await sameAsE("select side, percent, state, is_owner from public.api_parties where release_id = $1::uuid", [r.releaseId]);
    assert.equal((parties[0] as { percent: string }).percent, "33.33");
    // A job: uuid and the bigint seq as text; the job result's table.
    const [{ id: jobId }] = await db.query<{ id: string }>("select public.api_create_job($1::uuid, 'process_release') as id", [r.releaseId]);
    await sameAsE("select id, seq, state, created_at, started_at from public.api_jobs where id = $1::uuid", [jobId]);
    await db.query("select * from public.api_apply_job_result($1::uuid, false, 'plain words')", [jobId]);
    // Safe to call twice, so the same call on both paths (both see a finished job).
    await sameAsE("select * from public.api_apply_job_result($1::uuid, false, 'plain words')", [jobId]);
    // Takedown: jsonb prefixes, parsed.
    const boss = await admin(db);
    const [t] = await db.query<{ audit_id: string; prefixes: string[] }>(
      "select * from public.api_takedown_release($1::uuid, $2::uuid, $3::text)",
      [r.releaseId, boss, "test"],
    );
    assert.deepEqual(t.prefixes, [
      `masters/${r.artistId}/${r.releaseId}/`,
      `streams/${r.artistId}/${r.releaseId}/`,
      `art/${r.artistId}/${r.releaseId}/`,
    ]);
    await sameAsE("select action, reason, removed, files_deleted_at from public.api_audit_log where id = $1::uuid", [t.audit_id]);
  });

  test("a transaction commits together; a failed one changes nothing and its error comes out unchanged", async () => {
    const r = await newRelease(db);
    await db.transaction(async (tx) => {
      await tx.query("update public.api_releases set title = $1::text where id = $2::uuid", ["One", r.releaseId]);
      await tx.query("update public.api_tracks set title = $1::text where release_id = $2::uuid", ["Two", r.releaseId]);
    });
    assert.equal((await db.query<{ title: string }>("select title from public.api_releases where id = $1::uuid", [r.releaseId]))[0].title, "One");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("update public.api_releases set title = 'Changed' where id = $1::uuid", [r.releaseId]);
        await tx.query("select public.api_create_job($1::uuid, 'process_release')", [r.releaseId]);
      }),
      (e: unknown) => e instanceof DatabaseError && e.code === "MC409" && e.message === "wrong_state: no processing job while draft",
    );
    assert.equal((await db.query<{ title: string }>("select title from public.api_releases where id = $1::uuid", [r.releaseId]))[0].title, "One");
  });

  test("session B's SQLSTATEs and messages surface unchanged: MC404, MC409, MC422, MC403 and 23xxx", async () => {
    const r = await newRelease(db);
    const expect = async (sql: string, params: string[], code: string, message: RegExp) => {
      await assert.rejects(db.query(sql, params), (e: unknown) => {
        assert.ok(e instanceof DatabaseError, "a DatabaseError");
        assert.equal(e.code, code);
        assert.match(e.message, message);
        return true;
      });
    };
    await expect("select public.api_create_job($1::uuid, 'process_release')", ["00000000-0000-0000-0000-000000000000"], "MC404", /^not_found: no such release$/);
    await expect("select public.api_create_job($1::uuid, 'process_release')", [r.releaseId], "MC409", /^wrong_state: /);
    await expect("select public.api_create_job($1::uuid, 'other')", [r.releaseId], "MC422", /^bad_kind: /);
    await expect("select * from public.api_takedown_release($1::uuid, $2::uuid, 'x')", [r.releaseId, r.ownerId], "MC403", /^not_allowed: /);
    await expect("delete from public.api_accounts where user_id = $1::uuid", [r.ownerId], "MC409", /^has_history: /);
    await expect("update public.api_releases set title = '' where id = $1::uuid", [r.releaseId], "23514", /check constraint/);
  });

  test("the Data API runs one statement per call: two in one call are refused", async () => {
    await assert.rejects(db.query("select 1; select 2"), (e: unknown) => e instanceof DatabaseError && e.code === "42601");
  });

  describe("Jobs and the worker skeleton", () => {
    const ecs = () => new FakeAws().on(RunTaskCommand, () => ({ tasks: [{ taskArn: "t" }] }));
    // A stand-in for session G's job-result function: it applies the result through B's function.
    const applyResult = (database: Database): ApplyJobResult => async (jobId: string, result: JobResult) => {
      await database.query("select * from public.api_apply_job_result($1::uuid, $2::boolean, $3::text)", [
        jobId, result.ok, result.ok ? null : result.message,
      ]);
    };
    const state = async (releaseId: string) =>
      (await db.query<{ state: string; failure_reason: string | null }>("select state, failure_reason from public.api_releases where id = $1::uuid", [releaseId]))[0];
    const deps = (process = processingNotBuilt, timeLimitMs?: number) => ({
      database: db,
      jobs: awsJobs({ database: db, applyResult: applyResult(db) }),
      process,
      timeLimitMs,
      log: () => {},
    });

    test("enqueue → Fargate task → worker claims it → success moves the release to awaiting_splits", async () => {
      const r = await processingRelease(db);
      const fake = ecs();
      const worker = fargateWorker({ ecs: fake, cluster: "c", taskDefinition: "td", container: "worker", subnets: ["s"], securityGroups: ["g"] });
      const { jobId } = await awsJobs({ database: db, worker }).enqueue({ kind: "process_release", releaseId: r.releaseId });
      assert.equal(fake.inputs(RunTaskCommand)[0].clientToken, jobId);
      assert.equal(await runOneJob(deps(async () => ({ ok: true })), jobId), jobId);
      assert.deepEqual(await state(r.releaseId), { state: "awaiting_splits", failure_reason: null });
      // A second task for the same job does nothing.
      assert.equal(await runOneJob(deps(async () => ({ ok: true })), jobId), null);
    });

    test("the skeleton's processing fails the release plainly; a crash is plain words, not a stack", async () => {
      const r = await processingRelease(db);
      const { jobId } = await awsJobs({ database: db }).enqueue({ kind: "process_release", releaseId: r.releaseId });
      await runOneJob(deps(), jobId);
      assert.deepEqual(await state(r.releaseId), {
        state: "failed",
        failure_reason: "Processing is not set up yet, so this release cannot move on. Nothing is wrong with your files.",
      });
      const r2 = await processingRelease(db);
      const { jobId: j2 } = await awsJobs({ database: db }).enqueue({ kind: "process_release", releaseId: r2.releaseId });
      await runOneJob(deps(async () => { throw new Error("at line 3 of secret.ts"); }), j2);
      assert.equal((await state(r2.releaseId)).failure_reason, "Processing stopped before it finished. Please upload the masters again, or contact us if it keeps happening.");
    });

    test("a job past its time limit is stopped; the sweep fails jobs left running and runs queued ones", async () => {
      const r = await processingRelease(db);
      const { jobId } = await awsJobs({ database: db }).enqueue({ kind: "process_release", releaseId: r.releaseId });
      await runOneJob(deps(() => new Promise(() => {}), 20), jobId);
      assert.equal((await state(r.releaseId)).failure_reason, "Processing took too long and was stopped. Please upload the masters again, or contact us if it keeps happening.");

      const dead = await processingRelease(db);
      const { jobId: deadJob } = await awsJobs({ database: db }).enqueue({ kind: "process_release", releaseId: dead.releaseId });
      await db.query("update public.api_jobs set state = 'running', started_at = now() - interval '5 hours' where id = $1::uuid", [deadJob]);
      assert.deepEqual(await failStuckJobs(deps()), [deadJob]);
      assert.equal((await state(dead.releaseId)).state, "failed");

      const waiting = await processingRelease(db);
      await awsJobs({ database: db }).enqueue({ kind: "process_release", releaseId: waiting.releaseId });
      assert.ok((await sweep(deps(async () => ({ ok: true })))) >= 1);
      assert.equal((await state(waiting.releaseId)).state, "awaiting_splits");
    });
  });

  describe("Schedules: what EventBridge Scheduler would run", () => {
    function setup() {
      const scheduler = new FakeAws().on(UpdateScheduleCommand, () => { throw awsError("ResourceNotFoundException"); }).on(CreateScheduleCommand, () => ({}));
      const schedules = eventBridgeSchedules({
        scheduler, database: db, group: "g", roleArn: "r", deadLetterArn: "d", resourceArn: "arn:cluster", secretArn: "arn:secret", databaseName: "milk_crate",
      });
      /** Fires the schedule as Scheduler would: its Input is one Data API ExecuteStatement. */
      const fire = async () => {
        const input = JSON.parse(scheduler.inputs(CreateScheduleCommand).at(-1).Target.Input);
        const { ExecuteStatementCommand } = await import("@aws-sdk/client-rds-data");
        return api.send(new ExecuteStatementCommand({ resourceArn: input.ResourceArn, secretArn: input.SecretArn, database: input.Database, sql: input.Sql, parameters: input.Parameters }));
      };
      return { scheduler, schedules, fire };
    }
    const releaseState = async (id: string) => (await db.query<{ state: string }>("select state from public.api_releases where id = $1::uuid", [id]))[0].state;

    test("api_release_go_live with p_release_id: the argument type comes from the catalog, and firing it goes live", async () => {
      const r = await scheduledRelease(db);
      const { scheduler, schedules, fire } = setup();
      await schedules.runSqlFunctionAt({ name: `go_live:${r.releaseId}`, fn: "api_release_go_live", args: { p_release_id: r.releaseId }, at: new Date(Date.now() + 86_400_000) });
      assert.equal(JSON.parse(scheduler.inputs(CreateScheduleCommand)[0].Target.Input).Sql, "select public.api_release_go_live(p_release_id => :p_release_id::uuid)");
      await fire();
      assert.equal(await releaseState(r.releaseId), "live");
    });

    test("a run after a takedown is harmless", async () => {
      const r = await scheduledRelease(db);
      const { schedules, fire } = setup();
      await schedules.runSqlFunctionAt({ name: `go_live:${r.releaseId}`, fn: "api_release_go_live", args: { p_release_id: r.releaseId }, at: new Date() });
      await db.query("select * from public.api_takedown_release($1::uuid, $2::uuid, 'claim')", [r.releaseId, await admin(db)]);
      await fire();
      assert.equal(await releaseState(r.releaseId), "taken_down");
    });

    test("a function that returns a table: only its input arguments count", async () => {
      const { scheduler, schedules } = setup();
      await schedules.runSqlFunctionAt({ name: "x", fn: "api_takedown_release", args: { p_release_id: "00000000-0000-0000-0000-000000000000", p_actor_id: null, p_reason: "r" }, at: new Date() });
      assert.equal(
        JSON.parse(scheduler.inputs(CreateScheduleCommand)[0].Target.Input).Sql,
        "select public.api_takedown_release(p_release_id => :p_release_id::uuid, p_actor_id => :p_actor_id::uuid, p_reason => :p_reason::text)",
      );
      await assert.rejects(schedules.runSqlFunctionAt({ name: "x", fn: "api_takedown_release", args: { release_id: "x" }, at: new Date() }), /no argument release_id/);
      await assert.rejects(schedules.runSqlFunctionAt({ name: "x", fn: "api_does_not_exist", at: new Date() }), /no single public function/);
    });

    test("a run that raises is an error from the Data API (Scheduler then sends it to the dead-letter queue)", async () => {
      const { schedules, fire } = setup();
      await schedules.runSqlFunctionAt({ name: "x", fn: "api_takedown_release", args: { p_release_id: "00000000-0000-0000-0000-000000000000", p_actor_id: null, p_reason: "r" }, at: new Date() });
      await assert.rejects(fire(), /SQLState: MC404/);
    });
  });

  describe("The account source: api_accounts to Cognito groups", () => {
    test("rows from the real table: artist and staff in their group; suspended and no row in none", async () => {
      const r = await newRelease(db);
      const [staff] = await db.query<{ user_id: string }>("insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'internal') returning user_id");
      const [gone] = await db.query<{ user_id: string }>("insert into public.api_accounts (user_id, account_type, suspended) values (gen_random_uuid(), 'administrator', true) returning user_id");
      const nobody = "8f0e7c1a-1111-4000-8000-0000000000ff";
      const groups: Record<string, string[]> = { [r.ownerId]: [], [staff.user_id]: ["artist"], [gone.user_id]: ["administrator"], [nobody]: ["internal"] };
      const cognito = new FakeAws()
        .on(ListUsersCommand, () => ({ Users: Object.keys(groups).map((sub) => ({ Username: sub, Attributes: [{ Name: "sub", Value: sub }] })) }))
        .on(AdminListGroupsForUserCommand, (i) => ({ Groups: groups[i.Username].map((GroupName) => ({ GroupName })) }))
        .on(AdminAddUserToGroupCommand, (i) => { groups[i.Username].push(i.GroupName); return {}; })
        .on(AdminRemoveUserFromGroupCommand, (i) => { groups[i.Username] = groups[i.Username].filter((g) => g !== i.GroupName); return {}; });
      await syncAccounts({ database: db, cognito, userPoolId: "pool", log: () => {} });
      assert.deepEqual(groups, { [r.ownerId]: ["artist"], [staff.user_id]: ["internal"], [gone.user_id]: [], [nobody]: [] });
    });

    test("post-confirmation writes the email into an existing row and never inserts one", async () => {
      const [row] = await db.query<{ user_id: string }>("insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'third_party') returning user_id");
      const cognito = new FakeAws().on(AdminListGroupsForUserCommand, () => ({ Groups: [] })).on(AdminAddUserToGroupCommand, () => ({}));
      const event = (sub: string) => ({ triggerSource: "PostConfirmation_ConfirmSignUp", userPoolId: "pool", userName: sub, request: { userAttributes: { sub, email: "tp@example.invalid", email_verified: "true" } } });
      await postConfirmation({ database: db, cognito, userPoolId: "pool" }, event(row.user_id));
      assert.equal((await db.query<{ email: string }>("select email from public.api_accounts where user_id = $1::uuid", [row.user_id]))[0].email, "tp@example.invalid");
      const stranger = "8f0e7c1a-1111-4000-8000-0000000000ee";
      await postConfirmation({ database: db, cognito, userPoolId: "pool", log: () => {} }, event(stranger));
      assert.deepEqual(await db.query("select 1 from public.api_accounts where user_id = $1::uuid", [stranger]), []);
    });
  });

  test("takedown: B's prefixes go to ObjectStorage.delete, then api_takedown_files_deleted", async () => {
    const r = await processingRelease(db);
    const [t] = await db.query<{ audit_id: string; prefixes: string[] }>("select * from public.api_takedown_release($1::uuid, $2::uuid, 'claim')", [r.releaseId, await admin(db)]);
    const s3 = new FakeAws()
      .on(ListMultipartUploadsCommand, () => ({}))
      .on(ListObjectsV2Command, () => ({ Contents: [] }))
      .on(DeleteObjectsCommand, () => ({}));
    const storage = s3Storage({ s3, presign: async () => "", bucket: "b", cloudFront: { domain: "d", keyPairId: "k", privateKey: async () => "", signCookies: () => ({}) } });
    for (const prefix of t.prefixes) await storage.delete(prefix);
    assert.deepEqual(s3.inputs(ListObjectsV2Command).map((i) => i.Prefix), t.prefixes.flatMap((p) => [p, p]));
    const [{ done }] = await db.query<{ done: boolean }>("select public.api_takedown_files_deleted($1::uuid) as done", [t.audit_id]);
    assert.equal(done, true);
  });
});

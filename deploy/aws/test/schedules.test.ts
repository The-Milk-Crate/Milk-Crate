import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateScheduleCommand, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import type { Database, SqlValue } from "../src/core.ts";
import { DATA_API_TARGET, atExpression, eventBridgeSchedules, scheduleName } from "../src/schedules.ts";
import { FakeAws, awsError } from "./fake-aws.ts";

const REL = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-13T10:00:30Z");

function fakeDb(types: Record<string, string> | null = { p_release_id: "uuid" }, count = 1) {
  const calls: { sql: string; params: SqlValue[] }[] = [];
  const db: Database = {
    async query<Row>(sql: string, params: SqlValue[] = []) {
      calls.push({ sql, params });
      return Array.from({ length: count }, () => ({ types })) as Row[];
    },
    async transaction(fn) { return fn(db); },
  };
  return { db, calls };
}

function schedules(scheduler: FakeAws, db: Database) {
  return eventBridgeSchedules({
    scheduler,
    database: db,
    group: "milk-crate-phase0",
    roleArn: "arn:role",
    deadLetterArn: "arn:dlq",
    resourceArn: "arn:cluster",
    secretArn: "arn:secret",
    databaseName: "milk_crate",
    now: () => NOW,
  });
}

test("schedule names: same name, same schedule; within Scheduler's rules", () => {
  const a = scheduleName(`go_live:${REL}`);
  assert.equal(a, scheduleName(`go_live:${REL}`));
  assert.notEqual(a, scheduleName(`go_live.${REL}`), "a : and a . do not collide");
  assert.match(a, /^[0-9A-Za-z_.-]{1,64}$/);
  assert.match(scheduleName("x".repeat(100)), /^[0-9A-Za-z_.-]{1,64}$/);
});

test("times are UTC, rounded up to the minute; a past time runs at the next minute", () => {
  assert.equal(atExpression(new Date("2026-12-01T00:00:00Z"), NOW), "at(2026-12-01T00:00:00)");
  assert.equal(atExpression(new Date("2026-12-01T00:00:01Z"), NOW), "at(2026-12-01T00:01:00)");
  assert.equal(atExpression(new Date("2020-01-01T00:00:00Z"), NOW), "at(2026-11-13T10:02:00)");
});

test("a run is a one-time schedule that calls the Data API, deletes itself, never retries and keeps failures", async () => {
  const { db, calls } = fakeDb();
  const scheduler = new FakeAws().on(UpdateScheduleCommand, () => { throw awsError("ResourceNotFoundException"); }).on(CreateScheduleCommand, () => ({}));
  await schedules(scheduler, db).runSqlFunctionAt({ name: `go_live:${REL}`, fn: "api_release_go_live", args: { p_release_id: REL }, at: new Date("2026-12-01T00:00:00Z") });
  assert.deepEqual(calls[0].params, ["api_release_go_live"]);
  const [input] = scheduler.inputs(CreateScheduleCommand);
  assert.equal(input.Name, scheduleName(`go_live:${REL}`));
  assert.equal(input.GroupName, "milk-crate-phase0");
  assert.equal(input.ScheduleExpression, "at(2026-12-01T00:00:00)");
  assert.equal(input.ScheduleExpressionTimezone, "UTC");
  assert.equal(input.ActionAfterCompletion, "DELETE");
  assert.deepEqual(input.FlexibleTimeWindow, { Mode: "OFF" });
  assert.equal(input.Target.Arn, DATA_API_TARGET);
  assert.equal(input.Target.RoleArn, "arn:role");
  assert.deepEqual(input.Target.RetryPolicy, { MaximumRetryAttempts: 0 });
  assert.deepEqual(input.Target.DeadLetterConfig, { Arn: "arn:dlq" });
  assert.deepEqual(JSON.parse(input.Target.Input), {
    ResourceArn: "arn:cluster",
    SecretArn: "arn:secret",
    Database: "milk_crate",
    Sql: "select public.api_release_go_live(p_release_id => :p_release_id::uuid)",
    Parameters: [{ name: "p_release_id", value: { stringValue: REL } }],
  });
  assert.ok(!JSON.parse(input.Target.Input).Sql.includes(REL), "the value is a parameter, not SQL text");
});

test("setting the same name again replaces the run", async () => {
  const { db } = fakeDb();
  const scheduler = new FakeAws().on(UpdateScheduleCommand, () => ({}));
  const s = schedules(scheduler, db);
  await s.runSqlFunctionAt({ name: "n", fn: "api_release_go_live", args: { p_release_id: REL }, at: new Date("2026-12-01T00:00:00Z") });
  await s.runSqlFunctionAt({ name: "n", fn: "api_release_go_live", args: { p_release_id: REL }, at: new Date("2026-12-02T00:00:00Z") });
  const updates = scheduler.inputs(UpdateScheduleCommand);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].Name, updates[1].Name);
  assert.equal(updates[1].ScheduleExpression, "at(2026-12-02T00:00:00)");
  assert.equal(scheduler.inputs(CreateScheduleCommand).length, 0);
  // Made by another call in between: replaced.
  let n = 0;
  const race = new FakeAws()
    .on(UpdateScheduleCommand, () => { if (n++ === 0) throw awsError("ResourceNotFoundException"); return {}; })
    .on(CreateScheduleCommand, () => { throw awsError("ConflictException"); });
  await schedules(race, db).runSqlFunctionAt({ name: "n", fn: "api_release_go_live", args: { p_release_id: REL }, at: new Date() });
  assert.deepEqual(race.names(), ["UpdateScheduleCommand", "CreateScheduleCommand", "UpdateScheduleCommand"]);
});

test("refuses bad names, functions outside api_, unknown arguments and bad times", async () => {
  const s = schedules(new FakeAws(), fakeDb().db);
  const at = new Date("2026-12-01T00:00:00Z");
  await assert.rejects(s.runSqlFunctionAt({ name: "a b", fn: "api_release_go_live", at }), /bad schedule name/);
  await assert.rejects(s.runSqlFunctionAt({ name: "a", fn: "pg_sleep", at }), /only public api_/);
  await assert.rejects(s.runSqlFunctionAt({ name: "a", fn: "api_x; drop", at }), /only public api_/);
  await assert.rejects(s.runSqlFunctionAt({ name: "a", fn: "api_release_go_live", args: { "x => 1); --": 1 }, at }), /bad argument/);
  await assert.rejects(s.runSqlFunctionAt({ name: "a", fn: "api_release_go_live", args: { p_other: 1 }, at }), /no argument p_other/);
  await assert.rejects(s.runSqlFunctionAt({ name: "a", fn: "api_release_go_live", at: new Date("x") }), /bad time/);
  const none = schedules(new FakeAws(), fakeDb(null, 0).db);
  await assert.rejects(none.runSqlFunctionAt({ name: "a", fn: "api_missing", at }), /no single public function/);
  const odd = schedules(new FakeAws(), fakeDb({ p: "uuid); drop table x; --" }).db);
  await assert.rejects(odd.runSqlFunctionAt({ name: "a", fn: "api_x", args: { p: "v" }, at }), /no argument p/);
});

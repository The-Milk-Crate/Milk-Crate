import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { CALL_TIMED_OUT, DatabaseError, RESULT_TOO_LARGE, dataApiDatabase, parseDataApiError } from "../src/database.ts";
import { FakeAws, awsError } from "./fake-aws.ts";

const ARNS = { resourceArn: "arn:aws:rds:eu-west-2:111111111111:cluster:c", secretArn: "arn:secret", database: "milk_crate" };

function db(fake: FakeAws, extra: Record<string, unknown> = {}) {
  return dataApiDatabase({ client: fake, ...ARNS, sleep: async () => {}, ...extra });
}

test("parameters become typed, named Data API parameters; values never go into the SQL", async () => {
  const fake = new FakeAws().on(ExecuteStatementCommand, () => ({ records: [], columnMetadata: [] }));
  const when = new Date("2026-11-13T10:00:00.123Z");
  await db(fake).query("select api_x($1::uuid, $2::int, $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, $8)", [
    "8f0e7c1a-0000-4000-8000-000000000001",
    3,
    1.5,
    true,
    when,
    ["a", "b"],
    { k: 1 },
    null,
  ]);
  const [input] = fake.inputs(ExecuteStatementCommand);
  assert.equal(input.sql, "select api_x(:p1::uuid, :p2::int, :p3, :p4, :p5::timestamptz, :p6::jsonb, :p7::jsonb, :p8)");
  assert.deepEqual(input.parameters, [
    { name: "p1", value: { stringValue: "8f0e7c1a-0000-4000-8000-000000000001" } },
    { name: "p2", value: { longValue: 3 } },
    { name: "p3", value: { doubleValue: 1.5 } },
    { name: "p4", value: { booleanValue: true } },
    { name: "p5", value: { stringValue: "2026-11-13T10:00:00.123Z" } },
    { name: "p6", value: { stringValue: '["a","b"]' } },
    { name: "p7", value: { stringValue: '{"k":1}' } },
    { name: "p8", value: { isNull: true } },
  ]);
  assert.equal(input.resourceArn, ARNS.resourceArn);
  assert.equal(input.secretArn, ARNS.secretArn);
  assert.equal(input.database, "milk_crate");
  assert.equal(input.includeResultMetadata, true);
  assert.equal(input.transactionId, undefined);
});

test("text that looks like SQL stays a value", async () => {
  const fake = new FakeAws().on(ExecuteStatementCommand, () => ({ records: [] }));
  const evil = "'); drop table api_releases; --";
  await db(fake).query("select $1::text", [evil]);
  const [input] = fake.inputs(ExecuteStatementCommand);
  assert.equal(input.sql, "select :p1::text");
  assert.equal(input.parameters[0].value.stringValue, evil);
});

test("refuses SQL that uses more parameters than given", async () => {
  const fake = new FakeAws();
  await assert.rejects(db(fake).query("select $1, $2", ["a"]), /uses \$2/);
  assert.equal(fake.sent.length, 0);
});

test("results read as on session E: numeric, bigint, date and timestamptz as text; json parsed", async () => {
  const fake = new FakeAws().on(ExecuteStatementCommand, () => ({
    columnMetadata: [
      { name: "id", typeName: "uuid" },
      { name: "n", typeName: "int4" },
      { name: "seq", typeName: "int8" },
      { name: "percent", typeName: "numeric" },
      { name: "f", typeName: "float8" },
      { name: "ok", typeName: "bool" },
      { name: "d", typeName: "date" },
      { name: "at", typeName: "timestamptz" },
      { name: "at0", typeName: "timestamptz" },
      { name: "local", typeName: "timestamp" },
      { name: "j", typeName: "jsonb" },
      { name: "nothing", typeName: "text" },
      { name: "tags", typeName: "_text" },
      { label: "renamed", name: "x", typeName: "text" },
    ],
    records: [
      [
        { stringValue: "8f0e7c1a-0000-4000-8000-000000000001" },
        { longValue: 7 },
        { longValue: 9007199254740991 },
        { stringValue: "33.33" },
        { doubleValue: 0.5 },
        { booleanValue: false },
        { stringValue: "2026-11-13" },
        { stringValue: "2026-11-13 10:00:00.123450" },
        { stringValue: "2026-11-13 10:00:00" },
        { stringValue: "2026-11-13 10:00:00.5" },
        { stringValue: '{"prefixes":["masters/a/"]}' },
        { isNull: true },
        { arrayValue: { stringValues: ["a", "b"] } },
        { stringValue: "y" },
      ],
    ],
  }));
  const [row] = await db(fake).query("select 1");
  assert.deepEqual(row, {
    id: "8f0e7c1a-0000-4000-8000-000000000001",
    n: 7,
    seq: "9007199254740991",
    percent: "33.33",
    f: 0.5,
    ok: false,
    d: "2026-11-13",
    // Postgres's own text, as session E returns it with the session in UTC: microseconds kept
    // (trailing zeros dropped, as Postgres prints them) and the +00 offset.
    at: "2026-11-13 10:00:00.12345+00",
    at0: "2026-11-13 10:00:00+00",
    local: "2026-11-13 10:00:00.5",
    j: { prefixes: ["masters/a/"] },
    nothing: null,
    tags: ["a", "b"],
    renamed: "y",
  });
});

test("a Postgres error from session B surfaces as DatabaseError with the SQLSTATE and message", async () => {
  for (const code of ["MC403", "MC404", "MC409", "MC422", "23514"]) {
    const fake = new FakeAws().on(ExecuteStatementCommand, () => {
      throw awsError(
        "DatabaseErrorException",
        `ERROR: wrong_state: a release cannot move from draft to live\n  Where: PL/pgSQL function api_releases_guard() line 12 at RAISE; SQLState: ${code}`,
        400,
      );
    });
    await assert.rejects(db(fake).query("select 1"), (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.name, "DatabaseError");
      assert.equal(error.code, code);
      assert.equal(error.message, "wrong_state: a release cannot move from draft to live");
      return true;
    });
  }
});

test("the older BadRequestException form parses the same", () => {
  const e = parseDataApiError(awsError("BadRequestException", "ERROR: not_found: no such job; SQLState: MC404"));
  assert.equal(e?.code, "MC404");
  assert.equal(e?.message, "not_found: no such job");
});

test("an error with no SQLSTATE (access, network) is passed on as it is", async () => {
  const original = awsError("AccessDeniedException", "not allowed", 403);
  const fake = new FakeAws().on(ExecuteStatementCommand, () => {
    throw original;
  });
  await assert.rejects(db(fake).query("select 1"), (e) => e === original);
});

test("the Data API's limits: over 1 MB and past 45 seconds become plain DatabaseErrors", async () => {
  const big = new FakeAws().on(ExecuteStatementCommand, () => {
    throw awsError("BadRequestException", "Database returned more than the allowed response size limit");
  });
  await assert.rejects(db(big).query("select 1"), (e: any) => e.code === RESULT_TOO_LARGE && /1 MB/.test(e.message));
  const slow = new FakeAws().on(ExecuteStatementCommand, () => {
    throw awsError("StatementTimeoutException", "Request timed out");
  });
  await assert.rejects(db(slow).query("select 1"), (e: any) => e.code === CALL_TIMED_OUT && /45 second/.test(e.message));
});

test("waits while Aurora resumes from a pause, then runs", async () => {
  let calls = 0;
  const fake = new FakeAws().on(ExecuteStatementCommand, () => {
    calls++;
    if (calls < 3) throw awsError("DatabaseResumingException", "The Aurora DB instance is resuming after being auto-paused.");
    return { records: [[{ longValue: 1 }]], columnMetadata: [{ name: "one", typeName: "int4" }] };
  });
  assert.deepEqual(await db(fake).query("select 1 as one"), [{ one: 1 }]);
  assert.equal(calls, 3);
  const never = new FakeAws().on(ExecuteStatementCommand, () => {
    throw awsError("DatabaseResumingException", "resuming");
  });
  await assert.rejects(db(never, { resumeRetries: 2 }).query("select 1"), /resuming/);
  assert.equal(never.sent.length, 3);
});

test("a transaction carries its id on every statement and commits", async () => {
  const order: string[] = [];
  const fake = new FakeAws()
    .on(BeginTransactionCommand, () => ({ transactionId: "tx-1" }))
    .on(ExecuteStatementCommand, async (input) => {
      order.push(`start ${input.sql}`);
      await new Promise((r) => setTimeout(r, input.sql.includes("1") ? 20 : 1));
      order.push(`end ${input.sql}`);
      return { records: [] };
    })
    .on(CommitTransactionCommand, () => ({ transactionStatus: "Transaction Committed" }));
  const result = await db(fake).transaction(async (tx) => {
    // Two at once: the Data API refuses that in one transaction, so they run in turn.
    await Promise.all([tx.query("select 1"), tx.query("select 2")]);
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(order, ["start select 1", "end select 1", "start select 2", "end select 2"]);
  assert.ok(fake.inputs(ExecuteStatementCommand).every((i) => i.transactionId === "tx-1"));
  assert.deepEqual(fake.names(), ["BeginTransactionCommand", "ExecuteStatementCommand", "ExecuteStatementCommand", "CommitTransactionCommand"]);
  assert.deepEqual(fake.inputs(CommitTransactionCommand)[0], { resourceArn: ARNS.resourceArn, secretArn: ARNS.secretArn, transactionId: "tx-1" });
  assert.equal(fake.inputs(BeginTransactionCommand)[0].database, "milk_crate");
});

test("a failure in a transaction rolls back and surfaces the error", async () => {
  const fake = new FakeAws()
    .on(BeginTransactionCommand, () => ({ transactionId: "tx-2" }))
    .on(ExecuteStatementCommand, (input) => {
      if (input.sql.includes("bad")) throw awsError("DatabaseErrorException", "ERROR: no_reason: needs a reason; SQLState: MC422");
      return { records: [] };
    })
    .on(RollbackTransactionCommand, () => ({}));
  await assert.rejects(
    db(fake).transaction(async (tx) => {
      await tx.query("select 1");
      await tx.query("select bad");
    }),
    (e: any) => e instanceof DatabaseError && e.code === "MC422",
  );
  assert.deepEqual(fake.names().at(-1), "RollbackTransactionCommand");
  assert.equal(fake.inputs(CommitTransactionCommand).length, 0);
  // A throw from the caller's own code rolls back too.
  const fake2 = new FakeAws().on(BeginTransactionCommand, () => ({ transactionId: "tx-3" })).on(RollbackTransactionCommand, () => ({}));
  await assert.rejects(db(fake2).transaction(async () => { throw new Error("mine"); }), /mine/);
  assert.equal(fake2.inputs(RollbackTransactionCommand)[0].transactionId, "tx-3");
});

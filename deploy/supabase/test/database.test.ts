import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseError, type ClosableDatabase } from "../src/database.ts";
import { NEEDS_DB, newRelease, testDb } from "./helpers.ts";

describe("Database (postgres.js, local Postgres)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  before(() => { db = testDb(); });
  after(() => db.close());

  test("parameters travel as values, never as SQL text", async () => {
    const evil = "x'); drop table public.api_jobs; --";
    const [row] = await db.query<{ v: string }>("select $1::text as v", [evil]);
    assert.equal(row.v, evil);
    const [still] = await db.query<{ ok: boolean }>("select to_regclass('public.api_jobs') is not null as ok");
    assert.equal(still.ok, true);
  });

  test("numbers, booleans, null, dates and JSON", async () => {
    const at = new Date("2026-11-12T10:20:30.456Z");
    const [row] = await db.query<Record<string, unknown>>(
      "select $1::int + 1 as n, $2::boolean as b, $3::text is null as isnull, $4::timestamptz as t, $5::jsonb ->> 'k' as k, jsonb_array_length($6::jsonb) as len",
      [41, true, null, at, { k: "v" }, ["a", "b"]],
    );
    assert.deepEqual(row, { n: 42, b: true, isnull: true, t: "2026-11-12 10:20:30.456+00", k: "v", len: 2 });
  });

  test("timestamps keep their microseconds as text; numeric and bigint are text; jsonb is parsed", async () => {
    const [row] = await db.query<Record<string, unknown>>(
      "select '2026-01-02 03:04:05.123456+00'::timestamptz as ts, '2026-01-02'::date as d, 12.50::numeric as n, 9007199254740993::bigint as big, '{\"a\":1}'::jsonb as j",
    );
    assert.equal(row.ts, "2026-01-02 03:04:05.123456+00");
    assert.equal(row.d, "2026-01-02");
    assert.equal(row.n, "12.50");
    assert.equal(row.big, "9007199254740993");
    assert.deepEqual(row.j, { a: 1 });
  });

  test("a transaction commits together", async () => {
    const r = await newRelease(db);
    await db.transaction(async (tx) => {
      await tx.query("update public.api_releases set title = $1::text where id = $2::uuid", ["One", r.releaseId]);
      await tx.query("update public.api_tracks set title = $1::text where release_id = $2::uuid", ["Two", r.releaseId]);
    });
    const [row] = await db.query<{ title: string }>("select title from public.api_releases where id = $1::uuid", [r.releaseId]);
    assert.equal(row.title, "One");
  });

  test("a transaction that fails changes nothing, and the error comes out unchanged", async () => {
    const r = await newRelease(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("update public.api_releases set title = 'Changed' where id = $1::uuid", [r.releaseId]);
        await tx.query("select public.api_create_job($1::uuid, 'process_release')", [r.releaseId]);
      }),
      (e: unknown) => e instanceof DatabaseError && e.code === "MC409" && e.message === "wrong_state: no processing job while draft",
    );
    const [row] = await db.query<{ title: string }>("select title from public.api_releases where id = $1::uuid", [r.releaseId]);
    assert.equal(row.title, "Test");
  });

  test("session B's SQLSTATEs and messages surface unchanged: MC404, MC409, MC422, MC403", async () => {
    const r = await newRelease(db);
    const expect = async (sql: string, params: unknown[], code: string, message: RegExp) => {
      await assert.rejects(db.query(sql, params as never[]), (e: unknown) => {
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
  });

  test("plain constraint errors keep their 23xxx code", async () => {
    const r = await newRelease(db);
    await assert.rejects(
      db.query("insert into public.api_jobs (release_id, kind) values ($1::uuid, 'other')", [r.releaseId]),
      (e: unknown) => e instanceof DatabaseError && e.code === "23514" && /api_jobs_kind_check/.test(e.message),
    );
  });

  test("the connection role keeps access after session C's lock-down; clients do not", async () => {
    const [row] = await db.query<Record<string, boolean>>(
      `select current_user = 'postgres' as is_owner,
              has_table_privilege(current_user, 'public.api_jobs', 'select, insert, update') as owner_ok,
              has_table_privilege('authenticated', 'public.api_jobs', 'select') as auth_ok,
              has_table_privilege('anon', 'public.api_releases', 'select') as anon_ok`,
    );
    assert.deepEqual(row, { is_owner: true, owner_ok: true, auth_ok: false, anon_ok: false });
  });
});

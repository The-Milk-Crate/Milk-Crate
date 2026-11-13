import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Database, SqlValue } from "../src/core.ts";
import { postConfirmation, syncAccounts, syncOneAccount } from "../src/accounts.ts";
import { FakeAws } from "./fake-aws.ts";

const A = "8f0e7c1a-1111-4000-8000-00000000000a";
const B = "8f0e7c1a-1111-4000-8000-00000000000b";
const C = "8f0e7c1a-1111-4000-8000-00000000000c";
const D = "8f0e7c1a-1111-4000-8000-00000000000d";

/** A database stand-in that answers the sync's row query from a table, and records every call. */
function fakeDb(rows: { user_id: string; account_type: string; suspended: boolean }[], fail = false) {
  const calls: { sql: string; params: SqlValue[] }[] = [];
  const db: Database = {
    async query<Row>(sql: string, params: SqlValue[] = []) {
      calls.push({ sql, params });
      if (fail) throw new Error("database down");
      if (/from public\.api_accounts/.test(sql)) {
        const ids = params[0] as string[];
        return rows.filter((r) => ids.includes(r.user_id)) as Row[];
      }
      return [] as Row[];
    },
    async transaction(fn) {
      return fn(db);
    },
  };
  return { db, calls };
}

function fakeCognito(groups: Record<string, string[]>) {
  const users = Object.keys(groups);
  return new FakeAws()
    .on(ListUsersCommand, (input) => {
      if (input.Filter) {
        const sub = /sub = "(.+)"/.exec(input.Filter)![1];
        return { Users: users.includes(sub) ? [{ Username: `u-${sub}`, Attributes: [{ Name: "sub", Value: sub }] }] : [] };
      }
      // Two pages, to check paging.
      const page = input.PaginationToken === "2" ? users.slice(2) : users.slice(0, 2);
      return {
        Users: page.map((sub) => ({ Username: `u-${sub}`, Attributes: [{ Name: "sub", Value: sub }] })),
        PaginationToken: input.PaginationToken ? undefined : users.length > 2 ? "2" : undefined,
      };
    })
    .on(AdminListGroupsForUserCommand, (input) => ({ Groups: groups[input.Username.slice(2)].map((GroupName) => ({ GroupName })) }))
    .on(AdminAddUserToGroupCommand, () => ({}))
    .on(AdminRemoveUserFromGroupCommand, () => ({}));
}

test("the sync puts each user in their row's group and takes them out of the others", async () => {
  const { db } = fakeDb([
    { user_id: A, account_type: "artist", suspended: false },
    { user_id: B, account_type: "administrator", suspended: true },
    { user_id: C, account_type: "internal", suspended: false },
  ]);
  const cognito = fakeCognito({ [A]: [], [B]: ["administrator"], [C]: ["internal", "administrator"], [D]: ["artist"] });
  const totals = await syncAccounts({ database: db, cognito, userPoolId: "pool", log: () => {} });
  assert.deepEqual(totals, { users: 4, added: 1, removed: 3 });
  assert.deepEqual(cognito.inputs(AdminAddUserToGroupCommand), [{ UserPoolId: "pool", Username: `u-${A}`, GroupName: "artist" }]);
  assert.deepEqual(
    cognito.inputs(AdminRemoveUserFromGroupCommand).map((i) => [i.Username, i.GroupName]),
    [
      [`u-${B}`, "administrator"], // suspended: no group
      [`u-${C}`, "administrator"], // two groups: keep only the row's
      [`u-${D}`, "artist"], // no row: no group
    ],
  );
  assert.equal(cognito.inputs(ListUsersCommand).length, 2, "paged");
});

test("a second sync changes nothing", async () => {
  const { db } = fakeDb([{ user_id: A, account_type: "artist", suspended: false }]);
  const cognito = fakeCognito({ [A]: ["artist"], [B]: [] });
  assert.deepEqual(await syncAccounts({ database: db, cognito, userPoolId: "pool" }), { users: 2, added: 0, removed: 0 });
});

test("the row query passes the ids as one JSON list, never in the SQL text", async () => {
  const { db, calls } = fakeDb([]);
  await syncAccounts({ database: db, cognito: fakeCognito({ [A]: [], [B]: [] }), userPoolId: "pool" });
  assert.match(calls[0].sql, /jsonb_array_elements_text\(\$1::jsonb\)/);
  assert.deepEqual(calls[0].params, [[A, B]]);
  assert.ok(!calls[0].sql.includes(A));
});

test("one user by sub", async () => {
  const { db } = fakeDb([{ user_id: A, account_type: "third_party", suspended: false }]);
  const cognito = fakeCognito({ [A]: [] });
  assert.deepEqual(await syncOneAccount({ database: db, cognito, userPoolId: "pool" }, A), { added: ["third_party"], removed: [] });
  await assert.rejects(syncOneAccount({ database: db, cognito, userPoolId: "pool" }, "x"), /UUID/);
  await assert.rejects(syncOneAccount({ database: db, cognito, userPoolId: "pool" }, B), /no Cognito user/);
});

const event = (sub: string, email?: string) => ({
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp",
  region: "eu-west-2",
  userPoolId: "pool",
  userName: `u-${sub}`,
  callerContext: {},
  request: { userAttributes: { sub, email, email_verified: "true" } },
  response: {},
});

test("post-confirmation writes the email to an existing row only, then syncs the group, and returns the event", async () => {
  const { db, calls } = fakeDb([{ user_id: A, account_type: "artist", suspended: false }]);
  const cognito = fakeCognito({ [A]: [] });
  const e = event(A, "artist@example.invalid");
  assert.equal(await postConfirmation({ database: db, cognito, userPoolId: "pool" }, e), e);
  assert.match(calls[0].sql, /^update public\.api_accounts set email = \$2::text where user_id = \$1::uuid/);
  assert.deepEqual(calls[0].params, [A, "artist@example.invalid"]);
  assert.ok(!calls.some((c) => /insert/i.test(c.sql)), "never inserts a row");
  assert.equal(cognito.inputs(AdminAddUserToGroupCommand)[0].GroupName, "artist");
});

test("post-confirmation never throws (a throw would stop the sign-up)", async () => {
  const { db } = fakeDb([], true);
  const logs: string[] = [];
  const e = event(B, "b@example.invalid");
  assert.equal(await postConfirmation({ database: db, cognito: fakeCognito({ [B]: [] }), userPoolId: "pool", log: (m) => logs.push(m) }, e), e);
  assert.match(logs[0], /failed: database down/);
});

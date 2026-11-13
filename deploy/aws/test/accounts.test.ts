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
function fakeDb(rows: { user_id: string; account_type: string; suspended: boolean; email?: string | null }[], fail = false) {
  const calls: { sql: string; params: SqlValue[] }[] = [];
  const db: Database = {
    async query<Row>(sql: string, params: SqlValue[] = []) {
      calls.push({ sql, params });
      if (fail) throw new Error("database down");
      if (/^\s*update public\.api_accounts set email/.test(sql)) {
        const row = rows.find((r) => r.user_id === params[0]);
        if (!row || row.email === params[1]) return [] as Row[];
        row.email = params[1] as string;
        return [{ user_id: row.user_id }] as Row[];
      }
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

function fakeCognito(groups: Record<string, string[]>, emails: Record<string, { email: string; verified: boolean }> = {}) {
  const users = Object.keys(groups);
  const attrs = (sub: string) => [
    { Name: "sub", Value: sub },
    ...(emails[sub] ? [{ Name: "email", Value: emails[sub].email }, { Name: "email_verified", Value: String(emails[sub].verified) }] : []),
  ];
  return new FakeAws()
    .on(ListUsersCommand, (input) => {
      if (input.Filter) {
        const sub = /sub = "(.+)"/.exec(input.Filter)![1];
        return { Users: users.includes(sub) ? [{ Username: `u-${sub}`, Attributes: attrs(sub) }] : [] };
      }
      // Two pages, to check paging.
      const page = input.PaginationToken === "2" ? users.slice(2) : users.slice(0, 2);
      return {
        Users: page.map((sub) => ({ Username: `u-${sub}`, Attributes: attrs(sub) })),
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
  assert.deepEqual(totals, { users: 4, added: 1, removed: 3, emails: 0 });
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
  assert.deepEqual(await syncAccounts({ database: db, cognito, userPoolId: "pool" }), { users: 2, added: 0, removed: 0, emails: 0 });
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
  assert.deepEqual(await syncOneAccount({ database: db, cognito, userPoolId: "pool" }, A), { added: ["third_party"], removed: [], emailCopied: false });
  await assert.rejects(syncOneAccount({ database: db, cognito, userPoolId: "pool" }, "x"), /UUID/);
  await assert.rejects(syncOneAccount({ database: db, cognito, userPoolId: "pool" }, B), /no Cognito user/);
});

test("the sync copies a verified Cognito email into an existing row; never unverified, never a new row", async () => {
  const rows = [
    { user_id: A, account_type: "artist", suspended: false, email: null },
    { user_id: B, account_type: "internal", suspended: false, email: "old@example.invalid" },
    { user_id: C, account_type: "third_party", suspended: false, email: "same@example.invalid" },
  ];
  const { db, calls } = fakeDb(rows);
  const cognito = fakeCognito(
    { [A]: ["artist"], [B]: ["internal"], [C]: ["third_party"], [D]: [] },
    {
      [A]: { email: "a@example.invalid", verified: true },
      [B]: { email: "unverified@example.invalid", verified: false },
      [C]: { email: "same@example.invalid", verified: true },
      [D]: { email: "norow@example.invalid", verified: true },
    },
  );
  const totals = await syncAccounts({ database: db, cognito, userPoolId: "pool" });
  assert.equal(totals.emails, 1);
  assert.deepEqual(rows.map((r) => r.email), ["a@example.invalid", "old@example.invalid", "same@example.invalid"]);
  const writes = calls.filter((c) => /^\s*update/.test(c.sql));
  assert.deepEqual(writes.map((c) => c.params), [[A, "a@example.invalid"]], "only the verified, changed email with a row");
  assert.ok(!calls.some((c) => /insert/i.test(c.sql)), "never inserts a row");
  assert.ok(writes.every((c) => !c.sql.includes("example.invalid")), "the email is a parameter");
  // Run again: nothing to write.
  assert.equal((await syncAccounts({ database: db, cognito, userPoolId: "pool" })).emails, 0);
});

test("syncing one user copies their verified email too", async () => {
  const rows = [{ user_id: A, account_type: "artist", suspended: false, email: null }];
  const { db } = fakeDb(rows);
  const cognito = fakeCognito({ [A]: [] }, { [A]: { email: "a@example.invalid", verified: true } });
  assert.deepEqual(await syncOneAccount({ database: db, cognito, userPoolId: "pool" }, A), { added: ["artist"], removed: [], emailCopied: true });
  assert.equal(rows[0].email, "a@example.invalid");
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

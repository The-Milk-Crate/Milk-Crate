// Read access, cell by cell, from session C's fixture db/test/access-expected.json. The file is
// read at run time, so a change to it shows up here.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AccountType, ReleaseState } from "../src/platform/index.ts";
import { account, db, harness, seedRelease, uuid, type Account, type Seeded } from "./helpers.ts";

const fixture = JSON.parse(readFileSync(new URL("../../db/test/access-expected.json", import.meta.url), "utf8")) as {
  accountTypes: AccountType[];
  states: ReleaseState[];
  operations: Record<string, { byAccountType: Record<string, Record<"own" | "other", Record<string, ReleaseState[]>>> }>;
};

const h = harness("tus");
let owner: Account;
const callers = new Map<string, Account>();
const seeded = new Map<ReleaseState, Seeded>();

before(async () => {
  owner = await account("artist");
  for (const type of fixture.accountTypes) callers.set(type, await account(type));
  for (const state of fixture.states) seeded.set(state, await seedRelease(owner, state));
});
after(() => db.close());

function callerFor(type: AccountType, whose: "own" | "other"): Account {
  if (whose === "own") {
    assert.equal(type, "artist", "only an artist owns a release");
    return owner;
  }
  return callers.get(type)!;
}

async function listed(as: Account, state: ReleaseState, releaseId: string): Promise<number | boolean> {
  let cursor: string | undefined;
  for (;;) {
    const r = await h.call("listReleases", { as, query: { state, limit: "100", ...(cursor ? { cursor } : {}) } });
    if (r.status !== 200) return r.status;
    if (r.body.items.some((i: { id: string }) => i.id === releaseId)) return true;
    if (!r.body.nextCursor) return false;
    cursor = r.body.nextCursor;
  }
}

async function qualifiedFor(playId: string): Promise<number> {
  const [r] = await db.query<{ n: number }>("select count(*)::int as n from public.api_qualified_streams where play_id = $1::uuid", [playId]);
  return r.n;
}

async function keptFor(playId: string): Promise<number> {
  const [r] = await db.query<{ n: number }>("select count(*)::int as n from public.api_play_events where play_id = $1::uuid", [playId]);
  return r.n;
}

async function outcome(op: string, as: Account, s: Seeded, state: ReleaseState): Promise<string> {
  switch (op) {
    case "getRelease":
      return String((await h.call("getRelease", { as, params: { releaseId: s.releaseId } })).status);
    case "getPublicRelease":
      return String((await h.call("getPublicRelease", { as, params: { releaseId: s.releaseId } })).status);
    case "getPlayback":
      return String((await h.call("getPlayback", { as, params: { trackId: s.trackIds[0] } })).status);
    case "getCover":
      return String((await h.call("getCover", { as, params: { releaseId: s.releaseId } })).status);
    case "getUpload":
      return String((await h.call("getUpload", { as, params: { uploadId: s.openUploadId } })).status);
    case "listReleases": {
      const r = await listed(as, state, s.releaseId);
      return r === true ? "listed" : r === false ? "not_listed" : String(r);
    }
    case "recordPlays": {
      const playId = uuid();
      const r = await h.call("recordPlays", {
        as,
        headers: { "idempotency-key": uuid() },
        body: {
          events: [
            { type: "start", trackId: s.trackIds[0], playId, positionMs: 0, occurredAt: "2026-06-01T12:00:00Z" },
            { type: "end", trackId: s.trackIds[0], playId, positionMs: 31000, occurredAt: "2026-06-01T12:00:31Z" },
          ],
        },
      });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.equal(await keptFor(playId), 2, "the events are kept");
      return (await qualifiedFor(playId)) === 1 ? "qualifies" : "kept";
    }
    default:
      throw new Error(`no driver for ${op} in this test: add one`);
  }
}

describe("read access from db/test/access-expected.json", () => {
  for (const [op, spec] of Object.entries(fixture.operations)) {
    for (const [type, cells] of Object.entries(spec.byAccountType)) {
      for (const [whose, outcomes] of Object.entries(cells) as ["own" | "other", Record<string, ReleaseState[]>][]) {
        it(`${op}: ${type}, ${whose} release`, async () => {
          const seen: string[] = [];
          for (const [want, states] of Object.entries(outcomes)) {
            for (const state of states) {
              const got = await outcome(op, callerFor(type as AccountType, whose), seeded.get(state)!, state);
              if (got !== want) seen.push(`${state}: want ${want}, got ${got}`);
            }
          }
          assert.deepEqual(seen, []);
        });
      }
    }
  }

  it("covers every operation, account type and state in the fixture", () => {
    for (const [op, spec] of Object.entries(fixture.operations)) {
      assert.deepEqual(Object.keys(spec.byAccountType).sort(), [...fixture.accountTypes].sort(), op);
      for (const cells of Object.values(spec.byAccountType)) {
        for (const outcomes of Object.values(cells)) {
          assert.deepEqual(Object.values(outcomes).flat().sort(), [...fixture.states].sort(), op);
        }
      }
    }
  });

  it("no token is 401 on every read", async () => {
    const s = seeded.get("live")!;
    for (const [op, params] of [
      ["getRelease", { releaseId: s.releaseId }],
      ["getPublicRelease", { releaseId: s.releaseId }],
      ["getPlayback", { trackId: s.trackIds[0] }],
      ["getCover", { releaseId: s.releaseId }],
      ["getUpload", { uploadId: s.openUploadId }],
      ["listReleases", {}],
    ] as const) {
      const r = await h.call(op, { params });
      assert.equal(r.status, 401, op);
      assert.equal(r.body.code, "unauthorized");
      assert.ok(r.body.requestId);
    }
  });

  it("the public view hides owner_id, rights and review details", async () => {
    const r = await h.call("getPublicRelease", { as: callers.get("end_user"), params: { releaseId: seeded.get("live")!.releaseId } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["artistId", "hasCover", "id", "releaseDate", "title", "tracks"]);
    assert.equal(r.body.artistId, owner.artistId);
    assert.deepEqual(Object.keys(r.body.tracks[0]).sort(), ["id", "position", "title"]);
  });

  it("playback signs the streaming copy for the listener and adds the track id", async () => {
    const s = seeded.get("live")!;
    const listener = callers.get("end_user")!;
    const r = await h.call("getPlayback", { as: listener, params: { trackId: s.trackIds[0] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.method, "signed_url");
    assert.equal(r.body.trackId, s.trackIds[0]);
    assert.deepEqual(h.modules.storage.signedReads.at(-1), { key: s.streamKey, userId: listener.userId });
  });
});

describe("staff row check (settled with session C)", () => {
  // A token that still says staff, but the row says otherwise: the caller acts as end_user.
  const cases: [string, () => Promise<Account>][] = [
    ["suspended", async () => account("administrator", { suspended: true })],
    ["removed", async () => ({ userId: uuid(), type: "administrator" })],
    [
      "changed type",
      async () => {
        const a = await account("internal_accounting");
        return { ...a, type: "administrator" };
      },
    ],
  ];
  for (const [name, make] of cases) {
    it(`a ${name} administrator role stops at once`, async () => {
      const admin = await make();
      const draft = seeded.get("draft")!;
      const live = seeded.get("live")!;
      assert.equal((await h.call("getRelease", { as: admin, params: { releaseId: draft.releaseId } })).status, 403);
      assert.equal((await h.call("listReleases", { as: admin })).status, 403);
      assert.equal((await h.call("getPlayback", { as: admin, params: { trackId: draft.trackIds[0] } })).status, 404);
      assert.equal((await h.call("getCover", { as: admin, params: { releaseId: draft.releaseId } })).status, 404);
      assert.equal((await h.call("getPlayback", { as: admin, params: { trackId: live.trackIds[0] } })).status, 200);
      assert.equal(
        (await h.call("reviewRelease", { as: admin, params: { releaseId: seeded.get("awaiting_review")!.releaseId }, body: { decision: "approve" } })).status,
        403,
      );
      assert.equal(
        (await h.call("takedownRelease", { as: admin, params: { releaseId: draft.releaseId }, body: { reason: "test" } })).status,
        403,
      );
    });
  }

  it("a new staff role waits for the token refresh", async () => {
    // The row says administrator, the token still says end_user.
    const a = await account("administrator");
    const r = await h.call("getRelease", { as: { userId: a.userId, type: "end_user" }, params: { releaseId: seeded.get("draft")!.releaseId } });
    assert.equal(r.status, 403);
  });

  it("a suspended artist cannot act on their own release, and reads as a listener", async () => {
    const artist = await account("artist");
    const mine = await seedRelease(artist, "draft");
    await db.query("update public.api_accounts set suspended = true where user_id = $1::uuid", [artist.userId]);
    assert.equal((await h.call("getRelease", { as: artist, params: { releaseId: mine.releaseId } })).status, 403);
    assert.equal((await h.call("getPlayback", { as: artist, params: { trackId: mine.trackIds[0] } })).status, 404);
    assert.equal(
      (await h.call("updateRelease", { as: artist, params: { releaseId: mine.releaseId }, body: { title: "New" } })).status,
      403,
    );
    assert.equal(
      (await h.call("createRelease", { as: artist, body: { title: "X", releaseDate: "2026-07-01", tracks: [{ title: "A" }] } })).status,
      403,
    );
  });
});

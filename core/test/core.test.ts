// The router, error mapping, image reader, release edits and listing.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { imageSize, makeRetryTakedownDeletes, makeRouter, operations } from "../src/handlers/index.ts";
import { mapModuleError } from "../src/handlers/http.ts";
import { account, db, harness, jpegHead, pngHead, releaseState, seedRelease, testOptions, uuid } from "./helpers.ts";
import { DatabaseError } from "./pg.ts";
import { StorageError } from "./fakes.ts";

after(() => db.close());

describe("router", () => {
  it("maps every operation's method and path, and anything else is the contract's 404", async () => {
    const h = harness();
    const router = makeRouter(testOptions());
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const r = await router(
      new Request(`https://x.invalid/v1/releases/${s.releaseId}`, { headers: { authorization: `Bearer ${artist.userId} artist` } }),
      h.modules,
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, s.releaseId);
    for (const [method, path] of [
      ["GET", "/v1/nothing"],
      ["DELETE", `/v1/releases/${s.releaseId}`],
      ["GET", "/releases"],
    ]) {
      const miss = await router(new Request(`https://x.invalid${path}`, { method }), h.modules);
      assert.equal(miss.status, 404);
      const body = await miss.json();
      assert.equal(body.code, "not_found");
      assert.ok(body.requestId);
    }
    const sub = await router(new Request(`https://x.invalid/v1/releases/${s.releaseId}/`, { headers: { authorization: `Bearer ${artist.userId} artist` } }), h.modules);
    assert.equal(sub.status, 200, "a trailing slash is the same path");
  });

  it("lists each operation's route once, as E's serveOperation and F's routes.json take it", () => {
    const routes = Object.values(operations).map((o) => o.route);
    assert.equal(new Set(routes).size, 21);
    for (const route of routes) assert.match(route, /^(GET|POST|PUT|PATCH) \/v1\/[a-z/{}A-Z]+$/);
    assert.equal(operations.getRelease.route, "GET /v1/releases/{releaseId}");
  });

  it("a handler used alone refuses another operation's path", async () => {
    const h = harness();
    const r = await operations.getRelease.handler(new Request("https://x.invalid/v1/plays", { method: "POST" }), h.modules);
    assert.equal(r.status, 404);
  });

  it("keeps the caller's x-request-id; a thrown error is a 500 with no details, logged", async () => {
    const h = harness();
    const r = await h.call("getRelease", { params: { releaseId: uuid() }, headers: { "x-request-id": "abc-123" } });
    assert.equal(r.body.requestId, "abc-123");
    assert.equal(r.headers.get("x-request-id"), "abc-123");
    const broken = { ...h.modules, identity: { whoIs: async () => { throw new Error("secret detail"); } } };
    const res = await h.ops.getRelease.handler(new Request(`https://x.invalid/v1/releases/${uuid()}`), broken);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["code", "message", "requestId"]);
    assert.ok(!JSON.stringify(body).includes("secret detail"));
    assert.ok(h.options.logs.some((l) => l.includes("secret detail")));
  });
});

describe("error mapping (both deployments' shapes)", () => {
  it("maps session B's SQLSTATEs and code words", () => {
    for (const [code, status] of [["MC403", 403], ["MC404", 404], ["MC409", 409], ["MC422", 422]] as const) {
      const f = mapModuleError(new DatabaseError(code, "wrong_state: a release cannot move from draft to live"))!;
      assert.equal(f.status, status);
      assert.equal(f.code, "wrong_state");
      assert.equal(f.message, "A release cannot move from draft to live.");
    }
    assert.equal(mapModuleError(new DatabaseError("23514", "new row violates check constraint"))!.status, 422);
    assert.equal(mapModuleError(new DatabaseError("40001", "could not serialize")), null);
  });

  it("maps storage's statuses: 404, 413 (to 422 too_large) and 400", () => {
    assert.equal(mapModuleError(new StorageError(404, "no object"))!.status, 404);
    const big = mapModuleError(new StorageError(413, "this deployment takes files up to 52428800 bytes"))!;
    assert.deepEqual([big.status, big.code], [422, "too_large"]);
    assert.equal(mapModuleError(new StorageError(400, "bad"))!.status, 400);
    assert.equal(mapModuleError(new StorageError(500, "down")), null);
    assert.equal(mapModuleError(new TypeError("x")), null);
  });
});

describe("image reader", () => {
  it("reads PNG and JPEG sizes, and refuses anything else", () => {
    assert.deepEqual(imageSize(pngHead(3000, 3000)), { format: "png", width: 3000, height: 3000 });
    assert.deepEqual(imageSize(jpegHead(1400, 1400, 60000)), { format: "jpeg", width: 1400, height: 1400 });
    // A progressive JPEG (SOF2) with fill bytes before the marker.
    const prog = jpegHead(800, 600);
    const at = prog.indexOf(0xc0);
    prog[at] = 0xc2;
    assert.deepEqual(imageSize(prog), { format: "jpeg", width: 800, height: 600 });
    assert.equal(imageSize(new Uint8Array(0)), null);
    assert.equal(imageSize(pngHead(0, 10)), null);
    assert.equal(imageSize(pngHead(3000, 3000).slice(0, 20)), null, "cut short");
    assert.equal(imageSize(jpegHead(1400, 1400, 60000).slice(0, 1000)), null, "the size is past the bytes read");
    assert.equal(imageSize(new TextEncoder().encode("GIF89a.........")), null);
  });
});

describe("releases", () => {
  it("createRelease checks its body (400) and is artist only", async () => {
    const h = harness();
    const artist = await account("artist");
    for (const body of [
      {},
      { title: "", releaseDate: "2026-01-01", tracks: [{ title: "A" }] },
      { title: "   ", releaseDate: "2026-01-01", tracks: [{ title: "A" }] },
      { title: "T", releaseDate: "2026-02-30", tracks: [{ title: "A" }] },
      { title: "T", releaseDate: "2026-01-01", tracks: [] },
      { title: "T", releaseDate: "2026-01-01", tracks: [{}] },
      { title: "x".repeat(201), releaseDate: "2026-01-01", tracks: [{ title: "A" }] },
    ]) {
      assert.equal((await h.call("createRelease", { as: artist, body })).status, 400, JSON.stringify(body));
    }
    const r = await h.call("createRelease", { as: artist, body: { title: "T", releaseDate: "2026-01-01", tracks: Array(100).fill({ title: "A" }) } });
    assert.equal(r.status, 201);
    assert.equal(r.body.tracks.length, 100);
    assert.equal(r.body.tracks[99].position, 100);
    assert.match(r.body.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("updateRelease edits title, date and track order; a bad track list is 422", async () => {
    const h = harness();
    const artist = await account("artist");
    const c = await h.call("createRelease", { as: artist, body: { title: "Old", releaseDate: "2026-01-01", tracks: [{ title: "A" }, { title: "B" }, { title: "C" }] } });
    const releaseId = c.body.id;
    const [a, b, cc] = c.body.tracks.map((t: { id: string }) => t.id);
    const r = await h.call("updateRelease", {
      as: artist,
      params: { releaseId },
      body: { title: "New", releaseDate: "2026-12-31", tracks: [{ id: cc, title: "C2" }, { id: a }, { id: b }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.title, "New");
    assert.equal(r.body.releaseDate, "2026-12-31");
    assert.equal(r.body.state, "draft");
    assert.deepEqual(r.body.tracks.map((t: { id: string; title: string }) => [t.id, t.title]), [[cc, "C2"], [a, "A"], [b, "B"]]);
    for (const tracks of [[{ id: a }, { id: b }], [{ id: a }, { id: a }, { id: b }], [{ id: a }, { id: b }, { id: uuid() }]]) {
      const bad = await h.call("updateRelease", { as: artist, params: { releaseId }, body: { tracks } });
      assert.equal(bad.status, 422);
      assert.equal(bad.body.code, "bad_tracks");
    }
    assert.equal((await h.call("updateRelease", { as: artist, params: { releaseId }, body: {} })).status, 400);
    assert.equal((await h.call("updateRelease", { as: await account("artist"), params: { releaseId }, body: { title: "X" } })).status, 404);
  });

  it("listReleases pages newest first with a cursor, filters by state, and an artist sees only their own", async () => {
    const h = harness();
    const artist = await account("artist");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await h.call("createRelease", { as: artist, body: { title: `R${i}`, releaseDate: "2026-01-01", tracks: [{ title: "A" }] } });
      ids.push(c.body.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await h.call("listReleases", { as: artist, query: { limit: "2", ...(cursor ? { cursor } : {}) } });
      assert.equal(r.status, 200);
      assert.ok(r.body.items.length <= 2);
      for (const item of r.body.items) {
        assert.deepEqual(Object.keys(item).sort(), ["hasCover", "id", "owner_id", "releaseDate", "state", "title", "trackCount", "updatedAt"]);
        assert.equal(item.owner_id, artist.userId);
        seen.push(item.id);
      }
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    assert.deepEqual(seen, [...ids].reverse());
    const none = await h.call("listReleases", { as: artist, query: { state: "live" } });
    assert.deepEqual(none.body.items, []);
    assert.equal(none.body.nextCursor, undefined);
    for (const query of [{ state: "gone" }, { limit: "0" }, { limit: "101" }, { limit: "two" }, { cursor: "garbage" }] as Record<string, string>[]) {
      assert.equal((await h.call("listReleases", { as: artist, query })).status, 400, JSON.stringify(query));
    }
    const admin = await account("administrator");
    const all = await h.call("listReleases", { as: admin, query: { limit: "100" } });
    assert.ok(all.body.items.some((i: { id: string }) => i.id === ids[4]));
  });

  it("getRelease gives the owner view, with rights and review", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "failed");
    const r = await h.call("getRelease", { as: artist, params: { releaseId: s.releaseId } });
    assert.equal(r.status, 200);
    assert.equal(r.body.failureReason, "The master could not be read.");
    assert.deepEqual(Object.keys(r.body).sort(), [
      "createdAt",
      "failureReason",
      "hasCover",
      "id",
      "owner_id",
      "releaseDate",
      "review",
      "rights",
      "state",
      "title",
      "tracks",
      "updatedAt",
    ]);
    assert.equal((await h.call("getRelease", { as: artist, params: { releaseId: uuid() } })).status, 404);
    assert.equal((await h.call("getRelease", { as: artist, params: { releaseId: "not-a-uuid" } })).status, 400);
  });
});

describe("takedown when storage fails", () => {
  it("the release is still taken down; files_deleted_at stays empty and it is logged", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "live");
    h.modules.storage.failDelete = true;
    h.modules.secretsAndEmail.fail = true;
    const r = await h.call("takedownRelease", { as: await account("administrator"), params: { releaseId: s.releaseId }, body: { reason: "Test." } });
    assert.equal(r.status, 200);
    assert.equal(await releaseState(s.releaseId), "taken_down");
    const [audit] = await db.query<{ deleted: boolean }>("select files_deleted_at is not null as deleted from public.api_audit_log where id = $1::uuid", [r.body.auditId]);
    assert.equal(audit.deleted, false);
    assert.ok(h.options.logs.some((l) => l.includes("deleting the files failed")));
    assert.ok(h.options.logs.some((l) => l.includes("release_taken_down")));
    assert.equal((await h.call("takedownRelease", { as: await account("administrator"), params: { releaseId: s.releaseId }, body: { reason: " " } })).status, 400);

    // The sweep: left alone during the grace period, then deleted once storage is back, and
    // marked done only by the late pass, 2 hours or more after the takedown.
    h.modules.storage.objects.set(s.coverKey, new Uint8Array([1]));
    h.modules.storage.objects.set(s.streamKey, new Uint8Array([1]));
    const retry = makeRetryTakedownDeletes(h.modules, { limit: 1000, log: (m) => h.options.logs.push(m) });
    const early = await retry();
    assert.ok(![...early.deleted, ...early.waiting, ...early.failed].includes(r.body.auditId));
    await setTakedownAge(r.body.auditId, "20 minutes");
    const again = await retry();
    assert.ok(again.failed.includes(r.body.auditId), "storage still down");
    assert.ok(h.options.logs.some((l) => l.includes("failed again")));
    h.modules.storage.failDelete = false;
    const first = await retry();
    assert.ok(first.waiting.includes(r.body.auditId), "deleted, but before the late pass");
    assert.equal(h.modules.storage.objects.has(s.coverKey), false);
    assert.equal(h.modules.storage.objects.has(s.streamKey), false);
    assert.equal(await filesDeleted(r.body.auditId), false);
    await setTakedownAge(r.body.auditId, "2 hours");
    const done = await retry();
    assert.ok(done.deleted.includes(r.body.auditId));
    assert.equal(await filesDeleted(r.body.auditId), true);
    const last = await retry();
    assert.ok(![...last.deleted, ...last.waiting].includes(r.body.auditId), "done once");
  });
});

async function setTakedownAge(auditId: string, age: string): Promise<void> {
  await db.query("update public.api_audit_log set created_at = now() - $2::interval where id = $1::uuid", [auditId, age]);
}

async function filesDeleted(auditId: string): Promise<boolean> {
  const [row] = await db.query<{ deleted: boolean }>("select files_deleted_at is not null as deleted from public.api_audit_log where id = $1::uuid", [auditId]);
  return row.deleted;
}

describe("takedown's late pass (an upload open at the takedown)", () => {
  it("a master stored after the takedown is deleted by the late pass, and only that marks the row done", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "live");
    const r = await h.call("takedownRelease", { as: await account("administrator"), params: { releaseId: s.releaseId }, body: { reason: "Test." } });
    assert.equal(r.status, 200);
    assert.equal(await filesDeleted(r.body.auditId), false, "takedown deletes but does not mark done");

    // The open upload finishes after the takedown, as an unexpired Supabase token allows.
    const lateKey = `masters/${artist.artistId}/${s.releaseId}/${s.trackIds[0]}/original`;
    h.modules.storage.objects.set(lateKey, new Uint8Array([1]));
    const retry = makeRetryTakedownDeletes(h.modules, { limit: 1000 });

    await setTakedownAge(r.body.auditId, "1 hour");
    assert.ok((await retry()).waiting.includes(r.body.auditId));
    assert.equal(h.modules.storage.objects.has(lateKey), false);
    assert.equal(await filesDeleted(r.body.auditId), false, "an hour on, the late pass has not run");

    h.modules.storage.objects.set(lateKey, new Uint8Array([1]));
    await setTakedownAge(r.body.auditId, "2 hours 1 minute");
    assert.ok((await retry()).deleted.includes(r.body.auditId));
    assert.equal(h.modules.storage.objects.has(lateKey), false, "no master left");
    assert.equal(await filesDeleted(r.body.auditId), true);
  });

  it("latePassMinutes sets the window", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const r = await h.call("takedownRelease", { as: await account("administrator"), params: { releaseId: s.releaseId }, body: { reason: "Test." } });
    await setTakedownAge(r.body.auditId, "31 minutes");
    assert.ok((await makeRetryTakedownDeletes(h.modules, { limit: 1000 })()).waiting.includes(r.body.auditId));
    assert.ok((await makeRetryTakedownDeletes(h.modules, { limit: 1000, latePassMinutes: 30 })()).deleted.includes(r.body.auditId));
  });
});

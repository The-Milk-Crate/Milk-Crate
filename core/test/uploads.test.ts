// Uploads and cover art: storage's checks, the cover reader, sizes and the s3 confirm rule.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { account, db, harness, jpegHead, pngHead, releaseState, seedRelease, type Account } from "./helpers.ts";

after(() => db.close());

async function draft(h: ReturnType<typeof harness>, artist: Account, tracks = 1) {
  const c = await h.call("createRelease", {
    as: artist,
    body: { title: "U", releaseDate: "2026-01-01", tracks: Array.from({ length: tracks }, (_, i) => ({ title: `T${i}` })) },
  });
  assert.equal(c.status, 201);
  return { releaseId: c.body.id as string, trackIds: c.body.tracks.map((t: { id: string }) => t.id) as string[] };
}

async function coverUpload(h: ReturnType<typeof harness>, artist: Account, releaseId: string, format: "png" | "jpeg", head: Uint8Array) {
  const up = await h.call("startCoverUpload", { as: artist, params: { releaseId }, body: { format, sizeBytes: 100 } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  h.modules.storage.objects.set(up.body.objectKey, head);
  return up.body.uploadId as string;
}

describe("master uploads", () => {
  it("storage's incomplete or checksum_mismatch is 422 and the upload stays open", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId, trackIds } = await draft(h, artist);
    const up = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 10 } });
    for (const reason of ["incomplete", "checksum_mismatch"] as const) {
      h.modules.storage.confirmResult = { ok: false, reason };
      const r = await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body: { sha256: "a".repeat(64) } });
      assert.equal(r.status, 422);
      assert.equal(r.body.code, reason);
    }
    h.modules.storage.confirmResult = { ok: true };
    const ok = await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body: { sha256: "a".repeat(64) } });
    assert.equal(ok.status, 200);
    assert.equal(await releaseState(releaseId), "processing");
  });

  it("an s3_multipart confirm with no crc64nvme or no parts is 400 before storage (decided by K Marcus)", async () => {
    const h = harness("s3_multipart");
    const artist = await account("artist");
    const { releaseId, trackIds } = await draft(h, artist);
    const up = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 10 } });
    for (const body of [
      { sha256: "a".repeat(64) },
      { sha256: "a".repeat(64), crc64nvme: "AAAAAAAAAAA=" },
      { sha256: "a".repeat(64), parts: [{ partNumber: 1, etag: "x" }] },
      { sha256: "a".repeat(64), crc64nvme: "AAAAAAAAAAA=", parts: [] },
    ]) {
      const r = await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(h.modules.storage.confirms.length, 0);
  });

  it("a file over the deployment's limit (storage 413) is 422 too_large, and nothing is recorded", async () => {
    const h = harness();
    h.modules.storage.sizeLimit = 50 * 1024 * 1024;
    const artist = await account("artist");
    const { releaseId, trackIds } = await draft(h, artist);
    const r = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 60 * 1024 * 1024 } });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "too_large");
    assert.match(r.body.message, /52428800 bytes/);
    assert.equal(await releaseState(releaseId), "draft");
  });

  it("checks the request: format, size, sha256 (400)", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId, trackIds } = await draft(h, artist);
    for (const body of [
      { format: "mp3", sizeBytes: 10 },
      { format: "wav", sizeBytes: 0 },
      { format: "wav", sizeBytes: 5368709121 },
      { format: "wav", sizeBytes: 1.5 },
      { format: "wav" },
    ]) {
      assert.equal((await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body })).status, 400, JSON.stringify(body));
    }
    const up = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 5368709120 } });
    assert.equal(up.status, 201);
    for (const sha256 of ["A".repeat(64), "a".repeat(63), 7]) {
      assert.equal((await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body: { sha256 } })).status, 400);
    }
    assert.equal((await h.call("startUpload", { as: artist, params: { releaseId: "nope", trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 1 } })).status, 400);
    assert.equal((await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, rawBody: "{not json" })).status, 400);
  });

  it("a new upload replaces an open one; the old one is closed", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId, trackIds } = await draft(h, artist);
    const first = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 10 } });
    const second = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 20 } });
    assert.equal(second.status, 201);
    const r = await h.call("confirmUpload", { as: artist, params: { uploadId: first.body.uploadId }, body: { sha256: "a".repeat(64) } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "upload_closed");
  });

  it("getUpload answers 409 upload_closed for a replaced, confirmed or cancelled upload, before storage", async () => {
    const h = harness();
    const artist = await account("artist");
    const storageCalls: string[] = [];
    const real = h.modules.storage.getUpload.bind(h.modules.storage);
    h.modules.storage.getUpload = async (key, id) => {
      storageCalls.push(id);
      return real(key, id);
    };
    const { releaseId, trackIds } = await draft(h, artist);
    const first = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 10 } });
    assert.equal((await h.call("getUpload", { as: artist, params: { uploadId: first.body.uploadId } })).status, 200, "open");
    await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 20 } });
    storageCalls.length = 0;
    const replaced = await h.call("getUpload", { as: artist, params: { uploadId: first.body.uploadId } });
    assert.equal(replaced.status, 409);
    assert.equal(replaced.body.code, "upload_closed");

    const s = await seedRelease(artist, "live");
    const confirmed = await h.call("getUpload", { as: artist, params: { uploadId: s.uploadId } });
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.body.code, "upload_closed");

    const open = await seedRelease(artist, "draft");
    assert.equal((await h.call("getUpload", { as: artist, params: { uploadId: open.openUploadId } })).status, 200);
    const admin = await account("administrator");
    const down = await h.call("takedownRelease", { as: admin, params: { releaseId: open.releaseId }, body: { reason: "Test." } });
    assert.equal(down.status, 200);
    storageCalls.length = 0;
    const cancelled = await h.call("getUpload", { as: artist, params: { uploadId: open.openUploadId } });
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.code, "upload_closed");
    assert.deepEqual(storageCalls, [], "storage is not asked (Supabase would sign a fresh token)");
  });

  it("someone else's upload is 404", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId, trackIds } = await draft(h, artist);
    const up = await h.call("startUpload", { as: artist, params: { releaseId, trackId: trackIds[0] }, body: { format: "wav", sizeBytes: 10 } });
    const other = await account("artist");
    for (const op of ["getUpload", "signUploadParts", "confirmUpload"] as const) {
      const body = op === "getUpload" ? undefined : { sha256: "a".repeat(64), partNumbers: [1] };
      const r = await h.call(op, { as: other, params: { uploadId: up.body.uploadId }, body });
      assert.equal(r.status, 404, op);
    }
  });
});

describe("cover art", () => {
  it("a square PNG or JPEG is confirmed, replaces the cover and changes no state", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId } = await draft(h, artist);
    for (const [format, head] of [
      ["png", pngHead(1400, 1400)],
      ["jpeg", jpegHead(3000, 3000, 20000)],
    ] as const) {
      const id = await coverUpload(h, artist, releaseId, format, head);
      const r = await h.call("confirmUpload", { as: artist, params: { uploadId: id }, body: { sha256: "c".repeat(64) } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.releaseState, "draft");
    }
    const [cover] = await db.query<{ format: string; width: number }>("select format, width from public.api_covers where release_id = $1::uuid", [releaseId]);
    assert.deepEqual(cover, { format: "jpeg", width: 3000 });
    assert.equal(h.modules.jobs.enqueued.length, 0, "a cover queues no processing");
    assert.equal((await h.call("getRelease", { as: artist, params: { releaseId } })).body.hasCover, true);
  });

  it("not square, unreadable or the wrong format is 422 and keeps no cover", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId } = await draft(h, artist);
    const cases: [string, "png" | "jpeg", Uint8Array][] = [
      ["not_square", "png", pngHead(1000, 1001)],
      ["not_square", "jpeg", jpegHead(640, 480)],
      ["unreadable_image", "png", new Uint8Array([1, 2, 3, 4])],
      ["unreadable_image", "jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])],
      ["unreadable_image", "jpeg", pngHead(10, 10)],
    ];
    for (const [code, format, head] of cases) {
      const id = await coverUpload(h, artist, releaseId, format, head);
      const r = await h.call("confirmUpload", { as: artist, params: { uploadId: id }, body: { sha256: "c".repeat(64) } });
      assert.equal(r.status, 422, `${code} ${format}`);
      assert.equal(r.body.code, code);
    }
    assert.equal((await h.call("getCover", { as: artist, params: { releaseId } })).status, 404, "no cover");
  });

  it("a cover under 1400 pixels a side is 422 too_small (decided by K Marcus)", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId } = await draft(h, artist);
    const id = await coverUpload(h, artist, releaseId, "png", pngHead(1399, 1399));
    const r = await h.call("confirmUpload", { as: artist, params: { uploadId: id }, body: { sha256: "c".repeat(64) } });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "too_small");
  });

  it("a cover over 6000 pixels a side is 422 too_large_image (finding L3)", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId } = await draft(h, artist);
    for (const [format, head] of [["png", pngHead(6001, 6001)], ["jpeg", jpegHead(60000, 60000)]] as const) {
      const id = await coverUpload(h, artist, releaseId, format, head);
      const r = await h.call("confirmUpload", { as: artist, params: { uploadId: id }, body: { sha256: "c".repeat(64) } });
      assert.equal(r.status, 422, format);
      assert.equal(r.body.code, "too_large_image");
    }
    const id = await coverUpload(h, artist, releaseId, "png", pngHead(6000, 6000));
    assert.equal((await h.call("confirmUpload", { as: artist, params: { uploadId: id }, body: { sha256: "c".repeat(64) } })).status, 200);
  });

  it("R3: a cover upload left open is cancelled by submit; getUpload is 409 before storage, also once live", async () => {
    const h = harness();
    const artist = await account("artist");
    const reviewer = await account("internal");
    const s = await seedRelease(artist, "awaiting_splits");
    // A confirmed square cover, then a second cover upload left open.
    const first = await coverUpload(h, artist, s.releaseId, "png", pngHead(3000, 3000));
    assert.equal((await h.call("confirmUpload", { as: artist, params: { uploadId: first }, body: { sha256: "c".repeat(64) } })).status, 200);
    const open = await h.call("startCoverUpload", { as: artist, params: { releaseId: s.releaseId }, body: { format: "png", sizeBytes: 100 } });
    assert.equal(open.status, 201);
    assert.equal((await h.call("getUpload", { as: artist, params: { uploadId: open.body.uploadId } })).status, 200, "open while awaiting_splits");
    const rights = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: [{ side: "recording", role: "artist", name: "x", percent: 100 }, { side: "composition", role: "writer", name: "x", percent: 100 }] },
    });
    assert.equal(rights.status, 200, JSON.stringify(rights.body));
    assert.equal((await h.call("submitRelease", { as: artist, params: { releaseId: s.releaseId } })).status, 200);
    const [row] = await db.query<{ state: string }>("select state from public.api_uploads where id = $1::uuid", [open.body.uploadId]);
    assert.equal(row.state, "cancelled", "submit cancels the open upload");
    assert.equal((await h.call("reviewRelease", { as: reviewer, params: { releaseId: s.releaseId }, body: { decision: "approve" } })).status, 200);
    assert.equal((await h.call("publishRelease", { as: artist, params: { releaseId: s.releaseId } })).status, 200);
    assert.equal(await releaseState(s.releaseId), "live");
    const before = h.modules.storage.uploads.size;
    const got = await h.call("getUpload", { as: artist, params: { uploadId: open.body.uploadId } });
    assert.equal(got.status, 409);
    assert.equal(got.body.code, "upload_closed");
    assert.equal(h.modules.storage.uploads.size, before);
  });

  it("getUpload is 409 upload_closed when the release's state no longer allows that kind of upload (finding H2)", async () => {
    const h = harness();
    const artist = await account("artist");
    // seedRelease leaves an open master upload: allowed in draft, uploading, needs_changes, failed only.
    for (const [state, want] of [["draft", 200], ["failed", 200], ["processing", 409], ["awaiting_splits", 409], ["live", 409]] as const) {
      const s = await seedRelease(artist, state);
      const r = await h.call("getUpload", { as: artist, params: { uploadId: s.openUploadId } });
      assert.equal(r.status, want, state);
      if (want === 409) assert.equal(r.body.code, "upload_closed");
    }
    // A cover upload opened while processing is still served there.
    const s = await seedRelease(artist, "processing");
    const cover = await h.call("startCoverUpload", { as: artist, params: { releaseId: s.releaseId }, body: { format: "png", sizeBytes: 100 } });
    assert.equal(cover.status, 201);
    assert.equal((await h.call("getUpload", { as: artist, params: { uploadId: cover.body.uploadId } })).status, 200);
  });

  it("sizes up to 20 MiB, JPEG or PNG only", async () => {
    const h = harness();
    const artist = await account("artist");
    const { releaseId } = await draft(h, artist);
    for (const body of [{ format: "gif", sizeBytes: 10 }, { format: "png", sizeBytes: 20971521 }]) {
      assert.equal((await h.call("startCoverUpload", { as: artist, params: { releaseId }, body })).status, 400);
    }
    assert.equal((await h.call("startCoverUpload", { as: artist, params: { releaseId }, body: { format: "png", sizeBytes: 20971520 } })).status, 201);
  });

  it("getCover with no cover is 404 even for the owner", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "live");
    await db.query("delete from public.api_covers where release_id = $1::uuid", [s.releaseId]);
    const r = await h.call("getCover", { as: artist, params: { releaseId: s.releaseId } });
    assert.equal(r.status, 404);
  });
});

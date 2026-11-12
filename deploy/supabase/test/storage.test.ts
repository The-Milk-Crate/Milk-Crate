import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { supabaseStorage, emptyAndDeleteBucket, MASTER_MAX_BYTES } from "../src/storage.ts";
import { BASE, fakeStorage, PUBLISHABLE_KEY, SERVICE_KEY, tusSend } from "./fake-storage.ts";
import { fakeFetch } from "./helpers.ts";

const A = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";
const MASTER = `masters/${A}/${R}/${T}/original`;
const COVER = `art/${A}/${R}/cover/original`;
const STREAM = `streams/${A}/${R}/${T}/stream.mp3`;

function setup(opts: { storageUrl?: string } = {}) {
  const fake = fakeStorage({
    "mc-masters": { max: MASTER_MAX_BYTES, mimes: ["audio/wav", "audio/aiff", "audio/flac"] },
    "mc-streams": { max: null, mimes: null },
    "mc-art": { max: 20 * 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
  });
  const storage = supabaseStorage({
    supabaseUrl: BASE,
    storageUrl: opts.storageUrl,
    serviceKey: SERVICE_KEY,
    publishableKey: PUBLISHABLE_KEY,
    readTtlSeconds: 300,
    fetch: fake.fetch,
  });
  return { fake, storage };
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);

describe("ObjectStorage on Supabase Storage (mocked at the HTTP edge)", () => {
  test("startUpload opens a tus upload with the size fixed, and gives the client no secret", async () => {
    const { fake, storage } = setup({ storageUrl: "https://abcd.storage.supabase.co" });
    const s = await storage.startUpload({ key: MASTER, format: "wav", sizeBytes: 1000 });
    assert.equal(s.method, "tus");
    if (s.method !== "tus") return;
    assert.equal(s.offset, 0);
    assert.match(s.endpoint, /^https:\/\/abcd\.storage\.supabase\.co\/storage\/v1\/upload\/resumable\/sign\/u\d+$/);
    assert.ok(s.headers!["x-signature"]);
    assert.equal(s.headers!.apikey, PUBLISHABLE_KEY);
    assert.ok(!JSON.stringify(s).includes(SERVICE_KEY), "the secret key never reaches the client");
    assert.ok(!/^https?:/.test(MASTER) && s.providerUploadId.includes("#mc_started="));
    assert.ok(Date.parse(s.expiresAt) > Date.now() + 3600_000);
    const created = fake.requests.find((r) => r.path === "/upload/resumable/sign")!;
    assert.equal(created.headers["upload-length"], "1000");
    assert.equal(created.headers["x-upsert"], "true");
    const u = [...fake.uploads.values()][0];
    assert.deepEqual([u.bucket, u.key, u.contentType], ["mc-masters", MASTER, "audio/wav"]);
  });

  test("an interrupted upload resumes from the stored offset, then confirm checks the size", async () => {
    const { fake, storage } = setup();
    const file = bytes(1000);
    const s = await storage.startUpload({ key: MASTER, format: "flac", sizeBytes: 1000 });
    assert.equal(s.method, "tus");
    if (s.method !== "tus") return;
    assert.equal(await tusSend(fake.fetch, s, file, 0, 400), 400);
    // Interrupted. Not confirmable yet.
    assert.deepEqual(await storage.confirmUpload({ key: MASTER, providerUploadId: s.providerUploadId, sha256: "a".repeat(64) }), { ok: false, reason: "incomplete" });
    const again = await storage.getUpload(MASTER, s.providerUploadId);
    assert.equal(again.method === "tus" && again.offset, 400);
    if (again.method !== "tus") return;
    assert.notEqual(again.headers!["x-signature"], s.headers!["x-signature"], "a fresh token on resume");
    await tusSend(fake.fetch, again, file, again.offset);
    assert.deepEqual(await storage.confirmUpload({ key: MASTER, providerUploadId: s.providerUploadId, sha256: "a".repeat(64) }), { ok: true });
    assert.deepEqual(fake.objects.get(`mc-masters/${MASTER}`)!.bytes, file);
  });

  test("a stored size that differs from the session is checksum_mismatch, and the upload stays open", async () => {
    const { fake, storage } = setup();
    const s = await storage.startUpload({ key: MASTER, format: "wav", sizeBytes: 1000 });
    if (s.method !== "tus") return;
    // Someone used the token to open their own, shorter upload of the same object.
    fake.objects.set(`mc-masters/${MASTER}`, { bytes: bytes(10), modified: Date.now() + 5000, contentType: "audio/wav" });
    fake.uploads.get(s.endpoint.split("/").pop()!)!.gone = true;
    assert.deepEqual(await storage.confirmUpload({ key: MASTER, providerUploadId: s.providerUploadId, sha256: "a".repeat(64) }), { ok: false, reason: "checksum_mismatch" });
    // Nothing was deleted or closed: the client can retry.
    assert.ok(fake.objects.has(`mc-masters/${MASTER}`));
  });

  test("an old master at the same key does not confirm a replacement that never arrived", async () => {
    const { fake, storage } = setup();
    fake.objects.set(`mc-masters/${MASTER}`, { bytes: bytes(1000), modified: Date.now() - 3600_000, contentType: "audio/wav" });
    const s = await storage.startUpload({ key: MASTER, format: "wav", sizeBytes: 1000 });
    if (s.method !== "tus") return;
    fake.uploads.get(s.endpoint.split("/").pop()!)!.gone = true; // expired before any byte
    assert.deepEqual(await storage.confirmUpload({ key: MASTER, providerUploadId: s.providerUploadId, sha256: "a".repeat(64) }), { ok: false, reason: "incomplete" });
    const g = await storage.getUpload(MASTER, s.providerUploadId);
    assert.ok(g.method === "tus" && g.offset === 0 && Date.parse(g.expiresAt) <= Date.now(), "an expired upload reads as expired");
  });

  test("a finished upload whose tus record is gone still confirms from the object", async () => {
    const { fake, storage } = setup();
    const s = await storage.startUpload({ key: COVER, format: "png", sizeBytes: 50 });
    if (s.method !== "tus") return;
    await tusSend(fake.fetch, s, bytes(50), 0);
    fake.uploads.get(s.endpoint.split("/").pop()!)!.gone = true;
    assert.deepEqual(await storage.confirmUpload({ key: COVER, providerUploadId: s.providerUploadId, sha256: "b".repeat(64) }), { ok: true });
    const g = await storage.getUpload(COVER, s.providerUploadId);
    assert.equal(g.method === "tus" && g.offset, 50);
  });

  test("masters are WAV, AIFF or FLAC up to 5 GiB at masters/...; covers JPEG or PNG up to 20 MiB at art/...", async () => {
    const { storage } = setup();
    await assert.rejects(storage.startUpload({ key: MASTER, format: "png", sizeBytes: 10 }), /WAV, AIFF or FLAC/);
    await assert.rejects(storage.startUpload({ key: MASTER, format: "wav", sizeBytes: MASTER_MAX_BYTES + 1 }), /5 GiB/);
    await assert.rejects(storage.startUpload({ key: COVER, format: "flac", sizeBytes: 10 }), /JPEG or PNG/);
    await assert.rejects(storage.startUpload({ key: COVER, format: "jpeg", sizeBytes: 20 * 1024 * 1024 + 1 }), /20 MiB/);
    await assert.rejects(storage.startUpload({ key: STREAM, format: "wav", sizeBytes: 10 }), /only to a master or cover key/);
    await assert.rejects(storage.startUpload({ key: "https://evil/x", format: "wav", sizeBytes: 10 }), /only to a master or cover key/);
    const big = await storage.startUpload({ key: MASTER, format: "aiff", sizeBytes: MASTER_MAX_BYTES });
    assert.equal(big.method, "tus");
    const cover = await storage.startUpload({ key: COVER, format: "jpeg", sizeBytes: 20 * 1024 * 1024 });
    assert.equal(cover.method, "tus");
  });

  test("signParts is only for s3_multipart", async () => {
    await assert.rejects(setup().storage.signParts(MASTER, "x", [1]), /s3_multipart/);
  });

  test("readHead is a ranged read of the first bytes", async () => {
    const { fake, storage } = setup();
    fake.objects.set(`mc-art/${COVER}`, { bytes: bytes(5000), modified: Date.now(), contentType: "image/png" });
    const head = await storage.readHead(COVER, 64);
    assert.deepEqual(head, bytes(5000).slice(0, 64));
    const get = fake.requests.find((r) => r.method === "GET")!;
    assert.equal(get.headers.range, "bytes=0-63");
    await assert.rejects(storage.readHead(`art/${A}/${R}/cover/missing`, 64), /no object/);
  });

  test("readHead stops at the limit even if the server sends the whole object", async () => {
    const whole = fakeFetch(() => new Response(bytes(10_000), { status: 200 }));
    const storage = supabaseStorage({ supabaseUrl: BASE, serviceKey: SERVICE_KEY, fetch: whole.fetch });
    assert.equal((await storage.readHead(COVER, 100)).length, 100);
  });

  test("signRead: a fresh short-lived link per call, for streaming copies and covers only, never a master", async () => {
    const { fake, storage } = setup();
    fake.objects.set(`mc-streams/${STREAM}`, { bytes: bytes(10), modified: Date.now(), contentType: "audio/mpeg" });
    fake.objects.set(`mc-art/${COVER}`, { bytes: bytes(10), modified: Date.now(), contentType: "image/png" });
    fake.objects.set(`mc-masters/${MASTER}`, { bytes: bytes(10), modified: Date.now(), contentType: "audio/wav" });
    const before = Date.now();
    const a = await storage.signRead({ key: STREAM, userId: "listener-1" });
    const b = await storage.signRead({ key: STREAM, userId: "listener-2" });
    assert.equal(a.method, "signed_url");
    if (a.method !== "signed_url" || b.method !== "signed_url") return;
    assert.match(a.url, new RegExp(`^${BASE}/storage/v1/object/sign/mc-streams/streams/`));
    assert.notEqual(a.url, b.url);
    const life = Date.parse(a.expiresAt) - before;
    assert.ok(life >= 299_000 && life <= 301_000, `about 300 s, got ${life}`);
    const signReq = fake.requests.find((r) => r.path.startsWith("/object/sign/"))!;
    assert.equal(signReq.headers.apikey, SERVICE_KEY);
    assert.equal((await storage.signRead({ key: COVER, userId: "u" })).method, "signed_url");
    await assert.rejects(storage.signRead({ key: MASTER, userId: "u" }), /never|only streams/);
    await assert.rejects(storage.signRead({ key: `streams/${A}/${R}/`, userId: "u" }), /only streams/);
  });

  test("delete removes everything under a release prefix, in every subfolder, and nothing else", async () => {
    const { fake, storage } = setup();
    const other = "44444444-4444-4444-8444-444444444444";
    const put = (k: string) => fake.objects.set(k, { bytes: bytes(1), modified: Date.now(), contentType: "x" });
    put(`mc-streams/streams/${A}/${R}/${T}/a.mp3`);
    put(`mc-streams/streams/${A}/${R}/${T}/hls/seg1.ts`);
    put(`mc-streams/streams/${A}/${R}/${other}/a.mp3`);
    put(`mc-streams/streams/${A}/${other}/${T}/keep.mp3`);
    for (let i = 0; i < 1200; i++) put(`mc-streams/streams/${A}/${R}/${T}/many/f${i}`);
    await storage.delete(`streams/${A}/${R}/`);
    assert.deepEqual([...fake.objects.keys()], [`mc-streams/streams/${A}/${other}/${T}/keep.mp3`]);
  });

  test("delete refuses anything wider than a release folder", async () => {
    const { storage } = setup();
    for (const p of ["", "masters/", `masters/${A}/`, `masters/${A}/${R}`, `other/${A}/${R}/`, `masters/${A}/../`]) {
      await assert.rejects(storage.delete(p), /release folder/, p);
    }
  });

  test("tear-down empties then deletes a bucket", async () => {
    const f = fakeFetch((req) => new Response("{}", { status: req.method === "DELETE" || req.url.endsWith("/empty") ? 200 : 404 }));
    await emptyAndDeleteBucket({ supabaseUrl: BASE, serviceKey: SERVICE_KEY, fetch: f.fetch }, "mc-art");
    assert.deepEqual(f.calls.map((r) => `${r.method} ${new URL(r.url).pathname}`), [
      "POST /storage/v1/bucket/mc-art/empty",
      "DELETE /storage/v1/bucket/mc-art",
    ]);
  });
});

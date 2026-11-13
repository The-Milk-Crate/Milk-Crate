import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { StorageError, packUploadId, planParts, s3Storage, unpackUploadId, type SignCookies } from "../src/storage.ts";
import { s3Client } from "../src/modules.ts";
import { FakeAws, awsError } from "./fake-aws.ts";

const ART = "11111111-1111-4111-8111-111111111111";
const REL = "22222222-2222-4222-8222-222222222222";
const TRK = "33333333-3333-4333-8333-333333333333";
const MASTER = `masters/${ART}/${REL}/${TRK}/original`;
const COVER = `art/${ART}/${REL}/cover/original`;
const STREAM = `streams/${ART}/${REL}/${TRK}/stream.m4a`;
const MIB = 1024 ** 2;
const NOW = Date.parse("2026-11-13T10:00:00Z");
const CRC = "AAAAAAAAAAA=";

// A real S3 client with made-up credentials: presigning is local and needs no network.
process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "secret-example";
const presignClient = s3Client("eu-west-2");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function storage(s3: FakeAws, extra: Record<string, unknown> = {}) {
  return s3Storage({
    s3,
    presign: (command, expiresIn) => getSignedUrl(presignClient, command, { expiresIn }),
    bucket: "mc-files",
    cloudFront: {
      domain: "d111.cloudfront.net",
      keyPairId: "K2EXAMPLE",
      privateKey: async () => PEM,
      signCookies: getSignedCookies as unknown as SignCookies,
    },
    now: () => NOW,
    ...extra,
  });
}

test("part plan: 8 MiB parts, larger only to stay within 10,000; 5 GiB is 640 parts", () => {
  assert.deepEqual(planParts(1), { partSize: 8 * MIB, partCount: 1 });
  assert.deepEqual(planParts(20 * MIB), { partSize: 8 * MIB, partCount: 3 });
  assert.deepEqual(planParts(5 * 1024 ** 3), { partSize: 8 * MIB, partCount: 640 });
  const huge = planParts(100 * 1024 **3);
  assert.ok(huge.partCount <= 10_000 && huge.partSize % MIB === 0);
});

test("upload id packs the S3 id, start and size", () => {
  const id = packUploadId("abc.DEF-123_x", NOW, 42);
  assert.deepEqual(unpackUploadId(id), { s3UploadId: "abc.DEF-123_x", startedMs: NOW, sizeBytes: 42 });
  assert.throws(() => unpackUploadId("abc"), /not an upload id/);
});

test("startUpload opens a multipart upload with a full-object CRC64NVME and signs the first parts", async () => {
  const s3 = new FakeAws().on(CreateMultipartUploadCommand, () => ({ UploadId: "up-1" }));
  const size = 5 * 1024 ** 3;
  const session = await storage(s3).startUpload({ key: MASTER, format: "wav", sizeBytes: size });
  assert.deepEqual(s3.inputs(CreateMultipartUploadCommand)[0], {
    Bucket: "mc-files",
    Key: MASTER,
    ContentType: "audio/wav",
    ChecksumAlgorithm: "CRC64NVME",
    ChecksumType: "FULL_OBJECT",
  });
  assert.equal(session.method, "s3_multipart");
  if (session.method !== "s3_multipart") return;
  assert.equal(session.partCount, 640);
  assert.equal(session.partSize, 8 * MIB);
  assert.equal(session.parts.length, 50);
  assert.deepEqual(session.completedParts, []);
  assert.equal(session.expiresAt, new Date(NOW + 7 * 86_400_000).toISOString());
  assert.deepEqual(unpackUploadId(session.providerUploadId), { s3UploadId: "up-1", startedMs: NOW, sizeBytes: size });
  const url = new URL(session.parts[0].url);
  assert.equal(session.parts[0].partNumber, 1);
  assert.equal(url.searchParams.get("partNumber"), "1");
  assert.equal(url.searchParams.get("uploadId"), "up-1");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.ok(url.pathname.endsWith(MASTER), "the key, not a public URL of anything else");
  // No checksum is baked into the URL (the client cannot know a part's checksum here).
  assert.ok(![...url.searchParams.keys()].some((k) => /checksum/i.test(k)), url.search);
  assert.equal(session.parts[0].expiresAt, new Date(NOW + 3600_000).toISOString());
});

test("startUpload refuses what the contract does not allow", async () => {
  const st = storage(new FakeAws());
  await assert.rejects(st.startUpload({ key: MASTER, format: "jpeg", sizeBytes: 1 }), /WAV, AIFF or FLAC/);
  await assert.rejects(st.startUpload({ key: MASTER, format: "flac", sizeBytes: 5 * 1024 ** 3 + 1 }), /5 GiB/);
  await assert.rejects(st.startUpload({ key: COVER, format: "png", sizeBytes: 20 * MIB + 1 }), /20 MiB/);
  await assert.rejects(st.startUpload({ key: COVER, format: "wav", sizeBytes: 1 }), /JPEG or PNG/);
  await assert.rejects(st.startUpload({ key: STREAM, format: "wav", sizeBytes: 1 }), /only to a master or cover/);
});

test("a cover uses the same s3_multipart session", async () => {
  const s3 = new FakeAws().on(CreateMultipartUploadCommand, () => ({ UploadId: "up-c" }));
  const session = await storage(s3).startUpload({ key: COVER, format: "png", sizeBytes: 3 * MIB });
  assert.equal(session.method, "s3_multipart");
  assert.equal(s3.inputs(CreateMultipartUploadCommand)[0].ContentType, "image/png");
});

test("getUpload lists the stored parts (paged) and signs only the missing ones", async () => {
  const size = 30 * MIB; // 4 parts
  const id = packUploadId("up-2", NOW, size);
  const s3 = new FakeAws().on(ListPartsCommand, (input) =>
    input.PartNumberMarker
      ? { Parts: [{ PartNumber: 3, Size: 8 * MIB, ETag: '"e3"' }], IsTruncated: false }
      : { Parts: [{ PartNumber: 1, Size: 8 * MIB, ETag: '"e1"' }], IsTruncated: true, NextPartNumberMarker: "1" },
  );
  const session = await storage(s3).getUpload(MASTER, id);
  if (session.method !== "s3_multipart") throw new Error("method");
  assert.deepEqual(session.completedParts, [
    { partNumber: 1, sizeBytes: 8 * MIB },
    { partNumber: 3, sizeBytes: 8 * MIB },
  ]);
  assert.deepEqual(session.parts.map((p) => p.partNumber), [2, 4]);
  assert.equal(s3.inputs(ListPartsCommand).length, 2);
});

test("getUpload of a finished upload shows every part done; of an expired one, nothing and a past expiry", async () => {
  const size = 10 * MIB;
  const id = packUploadId("up-3", NOW, size);
  const gone = () => { throw awsError("NoSuchUpload", "gone", 404); };
  const done = new FakeAws().on(ListPartsCommand, gone).on(HeadObjectCommand, () => ({ ContentLength: size, LastModified: new Date(NOW + 5000) }));
  const finished = await storage(done).getUpload(MASTER, id);
  if (finished.method !== "s3_multipart") throw new Error("method");
  assert.deepEqual(finished.completedParts, [{ partNumber: 1, sizeBytes: 8 * MIB }, { partNumber: 2, sizeBytes: 2 * MIB }]);
  assert.deepEqual(finished.parts, []);
  const expired = new FakeAws().on(ListPartsCommand, gone).on(HeadObjectCommand, () => { throw awsError("NotFound", "", 404); });
  const old = await storage(expired).getUpload(MASTER, id);
  if (old.method !== "s3_multipart") throw new Error("method");
  assert.deepEqual(old.completedParts, []);
  assert.ok(Date.parse(old.expiresAt) <= NOW);
});

test("signParts signs the asked parts and refuses ones outside the upload", async () => {
  const id = packUploadId("up-4", NOW, 30 * MIB);
  const st = storage(new FakeAws());
  const parts = await st.signParts(MASTER, id, [4, 2, 2]);
  assert.deepEqual(parts.map((p) => p.partNumber), [4, 2]);
  await assert.rejects(st.signParts(MASTER, id, [5]), /parts 1 to 4/);
  await assert.rejects(st.signParts(MASTER, id, [0]), /parts 1 to 4/);
  await assert.rejects(st.signParts(MASTER, id, []), /1 to 1000/);
});

function confirmFake(size: number, opts: { parts?: { n: number; size: number }[]; complete?: () => unknown; head?: () => unknown } = {}) {
  const parts = opts.parts ?? [{ n: 1, size: 8 * MIB }, { n: 2, size: size - 8 * MIB }];
  return new FakeAws()
    .on(ListPartsCommand, () => ({ Parts: parts.map((p) => ({ PartNumber: p.n, Size: p.size, ETag: `"e${p.n}"` })), IsTruncated: false }))
    .on(CompleteMultipartUploadCommand, opts.complete ?? (() => ({})))
    .on(HeadObjectCommand, opts.head ?? (() => ({ ContentLength: size, LastModified: new Date(NOW + 1000), ChecksumCRC64NVME: CRC })));
}
const sentParts = [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: "e2" }];

test("confirm completes with the client's ETags and CRC64NVME, then checks size and CRC", async () => {
  const size = 10 * MIB;
  const s3 = confirmFake(size);
  const result = await storage(s3).confirmUpload({ key: MASTER, providerUploadId: packUploadId("up-5", NOW, size), sha256: "a".repeat(64), crc64nvme: CRC, parts: sentParts });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(s3.inputs(CompleteMultipartUploadCommand)[0], {
    Bucket: "mc-files",
    Key: MASTER,
    UploadId: "up-5",
    ChecksumCRC64NVME: CRC,
    ChecksumType: "FULL_OBJECT",
    MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"e1"' }, { PartNumber: 2, ETag: '"e2"' }] },
  });
  assert.equal(s3.inputs(HeadObjectCommand)[0].ChecksumMode, "ENABLED");
});

test("confirm: a missing part is incomplete; a wrong ETag or size is checksum_mismatch; nothing is completed", async () => {
  const size = 10 * MIB;
  const id = packUploadId("up-6", NOW, size);
  const base = { key: MASTER, providerUploadId: id, sha256: "a".repeat(64), crc64nvme: CRC };
  const missing = confirmFake(size, { parts: [{ n: 1, size: 8 * MIB }] });
  assert.deepEqual(await storage(missing).confirmUpload({ ...base, parts: sentParts }), { ok: false, reason: "incomplete" });
  const wrongEtag = confirmFake(size);
  assert.deepEqual(await storage(wrongEtag).confirmUpload({ ...base, parts: [{ partNumber: 1, etag: "e1" }, { partNumber: 2, etag: "zz" }] }), { ok: false, reason: "checksum_mismatch" });
  const short = confirmFake(size, { parts: [{ n: 1, size: 8 * MIB }, { n: 2, size: MIB }] });
  assert.deepEqual(await storage(short).confirmUpload({ ...base, parts: sentParts }), { ok: false, reason: "checksum_mismatch" });
  for (const s3 of [missing, wrongEtag, short]) {
    assert.equal(s3.inputs(CompleteMultipartUploadCommand).length, 0);
    assert.equal(s3.inputs(AbortMultipartUploadCommand).length, 0, "the upload stays open");
  }
});

test("confirm: S3 refusing the CRC64NVME is checksum_mismatch and the upload stays open", async () => {
  const size = 10 * MIB;
  const s3 = confirmFake(size, { complete: () => { throw awsError("BadDigest", "The CRC64NVME you specified did not match the calculated checksum.", 400); } });
  const result = await storage(s3).confirmUpload({ key: MASTER, providerUploadId: packUploadId("up-7", NOW, size), sha256: "a".repeat(64), crc64nvme: CRC, parts: sentParts });
  assert.deepEqual(result, { ok: false, reason: "checksum_mismatch" });
  assert.equal(s3.inputs(AbortMultipartUploadCommand).length, 0);
  assert.equal(s3.inputs(HeadObjectCommand).length, 0);
});

test("confirm again after a lost answer: the stored object is checked, and a stale one does not count", async () => {
  const size = 10 * MIB;
  const id = packUploadId("up-8", NOW, size);
  const gone = () => { throw awsError("NoSuchUpload", "", 404); };
  const input = { key: MASTER, providerUploadId: id, sha256: "a".repeat(64), crc64nvme: CRC, parts: sentParts };
  const again = new FakeAws().on(ListPartsCommand, gone).on(HeadObjectCommand, () => ({ ContentLength: size, LastModified: new Date(NOW + 1000), ChecksumCRC64NVME: CRC }));
  assert.deepEqual(await storage(again).confirmUpload(input), { ok: true });
  const stale = new FakeAws().on(ListPartsCommand, gone).on(HeadObjectCommand, () => ({ ContentLength: size, LastModified: new Date(NOW - 60_000), ChecksumCRC64NVME: CRC }));
  assert.deepEqual(await storage(stale).confirmUpload(input), { ok: false, reason: "incomplete" });
  const otherCrc = new FakeAws().on(ListPartsCommand, gone).on(HeadObjectCommand, () => ({ ContentLength: size, LastModified: new Date(NOW + 1), ChecksumCRC64NVME: "BBBBBBBBBBB=" }));
  assert.deepEqual(await storage(otherCrc).confirmUpload(input), { ok: false, reason: "checksum_mismatch" });
});

test("confirm needs crc64nvme and parts (a 400 StorageError)", async () => {
  const st = storage(new FakeAws());
  const id = packUploadId("up-9", NOW, 10);
  await assert.rejects(st.confirmUpload({ key: MASTER, providerUploadId: id, sha256: "a".repeat(64) }), (e: any) => e instanceof StorageError && e.status === 400);
  await assert.rejects(st.confirmUpload({ key: MASTER, providerUploadId: id, sha256: "a".repeat(64), crc64nvme: "nope", parts: sentParts }), (e: any) => e.status === 400);
});

test("readHead is a ranged GET, capped at 1 MiB; 404 and an empty object", async () => {
  const s3 = new FakeAws().on(GetObjectCommand, () => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3, 4, 5]) } }));
  assert.deepEqual(await storage(s3).readHead(COVER, 3), new Uint8Array([1, 2, 3]));
  assert.equal(s3.inputs(GetObjectCommand)[0].Range, "bytes=0-2");
  await storage(s3).readHead(COVER, 10 * MIB);
  assert.equal(s3.inputs(GetObjectCommand)[1].Range, `bytes=0-${MIB - 1}`);
  const missing = new FakeAws().on(GetObjectCommand, () => { throw awsError("NoSuchKey", "", 404); });
  await assert.rejects(storage(missing).readHead(COVER, 10), (e: any) => e instanceof StorageError && e.status === 404);
  const empty = new FakeAws().on(GetObjectCommand, () => { throw awsError("InvalidRange", "", 416); });
  assert.deepEqual(await storage(empty).readHead(COVER, 10), new Uint8Array(0));
});

function cookie(grant: { cookies: { name: string; value: string }[] }, name: string) {
  return grant.cookies.find((c) => c.name === name)?.value ?? "";
}
const unsafe = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");

test("signRead: CloudFront cookies for one track's streaming folder, 600 seconds, signed with the key", async () => {
  const s3 = new FakeAws().on(HeadObjectCommand, () => ({ ContentLength: 10 }));
  const grant = await storage(s3).signRead({ key: STREAM, userId: "u" });
  if (grant.method !== "cloudfront_cookies") throw new Error("method");
  assert.equal(grant.streamUrl, `https://d111.cloudfront.net/${STREAM}`);
  assert.equal(grant.expiresAt, new Date(NOW + 600_000).toISOString());
  assert.deepEqual(grant.cookies.map((c) => c.name).sort(), ["CloudFront-Key-Pair-Id", "CloudFront-Policy", "CloudFront-Signature"]);
  assert.equal(cookie(grant, "CloudFront-Key-Pair-Id"), "K2EXAMPLE");
  const policy = unsafe(cookie(grant, "CloudFront-Policy")).toString("utf8");
  assert.deepEqual(JSON.parse(policy), {
    Statement: [{ Resource: `https://d111.cloudfront.net/streams/${ART}/${REL}/${TRK}/*`, Condition: { DateLessThan: { "AWS:EpochTime": NOW / 1000 + 600 } } }],
  });
  assert.ok(verify("RSA-SHA1", Buffer.from(policy), publicKey, unsafe(cookie(grant, "CloudFront-Signature"))), "signature checks out");
  // A fresh grant each call.
  const later = s3Storage({ ...({} as any), s3, presign: async () => "", bucket: "mc-files", cloudFront: { domain: "d111.cloudfront.net", keyPairId: "K", privateKey: async () => PEM, signCookies: getSignedCookies as unknown as SignCookies }, now: () => NOW + 1000 });
  const second = await later.signRead({ key: STREAM, userId: "u" });
  assert.notEqual(cookie(second as any, "CloudFront-Policy"), cookie(grant, "CloudFront-Policy"));
});

test("signRead: a cover is scoped to its cover folder; never a master; 404 when there is no object", async () => {
  const s3 = new FakeAws().on(HeadObjectCommand, () => ({ ContentLength: 10 }));
  const grant = await storage(s3).signRead({ key: COVER, userId: "u" });
  if (grant.method !== "cloudfront_cookies") throw new Error("method");
  assert.match(unsafe(cookie(grant, "CloudFront-Policy")).toString(), new RegExp(`/art/${ART}/${REL}/cover/\\*`));
  await assert.rejects(storage(s3).signRead({ key: MASTER, userId: "u" }), /never|only streams/);
  await assert.rejects(storage(s3).signRead({ key: `streams/${ART}/${REL}/`, userId: "u" }), /only streams/);
  const missing = new FakeAws().on(HeadObjectCommand, () => { throw awsError("NotFound", "", 404); });
  await assert.rejects(storage(missing).signRead({ key: STREAM, userId: "u" }), (e: any) => e instanceof StorageError && e.status === 404);
});

test("delete aborts unfinished uploads, deletes in batches of 1,000 and checks nothing is left", async () => {
  const prefix = `masters/${ART}/${REL}/`;
  const keys = Array.from({ length: 1500 }, (_, i) => `${prefix}${TRK}/k${i}`);
  let deleted = false;
  const s3 = new FakeAws()
    .on(ListMultipartUploadsCommand, () => ({ Uploads: [{ Key: `${prefix}${TRK}/original`, UploadId: "open-1" }], IsTruncated: false }))
    .on(AbortMultipartUploadCommand, () => ({}))
    .on(ListObjectsV2Command, (input) => {
      if (deleted) return { Contents: [], IsTruncated: false };
      return input.ContinuationToken
        ? { Contents: keys.slice(1000).map((Key) => ({ Key })), IsTruncated: false }
        : { Contents: keys.slice(0, 1000).map((Key) => ({ Key })), IsTruncated: true, NextContinuationToken: "t" };
    })
    .on(DeleteObjectsCommand, (input) => {
      if (input.Delete.Objects.length < 1000) deleted = true;
      return {};
    });
  await storage(s3).delete(prefix);
  assert.deepEqual(s3.inputs(AbortMultipartUploadCommand), [{ Bucket: "mc-files", Key: `${prefix}${TRK}/original`, UploadId: "open-1" }]);
  assert.deepEqual(s3.inputs(DeleteObjectsCommand).map((i) => i.Delete.Objects.length), [1000, 500]);
  assert.ok(s3.inputs(ListObjectsV2Command).every((i) => i.Prefix === prefix));
});

test("delete reports objects S3 did not delete, and refuses anything wider than a release", async () => {
  const prefix = `art/${ART}/${REL}/`;
  const s3 = new FakeAws()
    .on(ListMultipartUploadsCommand, () => ({ IsTruncated: false }))
    .on(ListObjectsV2Command, () => ({ Contents: [{ Key: `${prefix}cover/original` }] }))
    .on(DeleteObjectsCommand, () => ({ Errors: [{ Key: `${prefix}cover/original`, Code: "AccessDenied" }] }));
  await assert.rejects(storage(s3).delete(prefix), (e: any) => e instanceof StorageError && /AccessDenied/.test(e.message));
  for (const wide of ["", "masters/", `masters/${ART}/`, `masters/${ART}/${REL}`, `other/${ART}/${REL}/`]) {
    await assert.rejects(storage(new FakeAws()).delete(wide), /release folder/, wide);
  }
});

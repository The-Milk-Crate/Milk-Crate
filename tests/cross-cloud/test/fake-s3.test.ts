// The fake S3 behaves as S3 does for session F's part URLs (session J3, finding M3): a part
// URL is signed with that part's size, so a body of another length is refused, and
// abortOtherUploads ends a replaced upload. F's own storage module, against the fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { s3Storage, type SignCookies } from "../../../deploy/aws/src/storage.ts";
import { fakeS3 } from "../lib/fake-s3.ts";

const awsRequire = createRequire(new URL("../../../deploy/aws/package.json", import.meta.url));
const { S3Client } = awsRequire("@aws-sdk/client-s3");
const { getSignedUrl } = awsRequire("@aws-sdk/s3-request-presigner");

const MIB = 1024 ** 2;
const ID = "11111111-1111-4111-8111-111111111111";
const MASTER = `masters/${ID}/${ID}/${ID}/original`;
const SECRET = "made-up-for-this-test";

function setup() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const s3 = fakeS3({
    bucket: "mc-files",
    region: "eu-west-2",
    cloudFrontDomain: "d111.cloudfront.net",
    cloudFrontPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyPairId: "K",
    secretAccessKey: SECRET,
  });
  const presigner = new S3Client({
    region: "eu-west-2",
    credentials: { accessKeyId: "AKIDTEST", secretAccessKey: SECRET },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const storage = s3Storage({
    s3: s3.s3,
    presign: (command, expiresIn) => getSignedUrl(presigner, command, { expiresIn }),
    bucket: "mc-files",
    cloudFront: { domain: "d111.cloudfront.net", keyPairId: "K", privateKey: async () => "", signCookies: (() => ({})) as SignCookies },
  });
  return { s3, storage };
}

const put = (fetchFn: typeof fetch, url: string, length: number) =>
  fetchFn(url, { method: "PUT", body: new Uint8Array(length) as Uint8Array<ArrayBuffer> });

test("a part URL takes only its planned size; the last part is smaller", async () => {
  const { s3, storage } = setup();
  const size = 8 * MIB + 10; // parts of 8 MiB and 10 bytes
  const session = await storage.startUpload({ key: MASTER, format: "wav", sizeBytes: size });
  if (session.method !== "s3_multipart") throw new Error("method");
  const [first, last] = session.parts;
  assert.equal((await put(s3.clientFetch, first.url, 8 * MIB + 1)).status, 403);
  assert.equal((await put(s3.clientFetch, first.url, 10)).status, 403);
  assert.equal((await put(s3.clientFetch, last.url, 8 * MIB)).status, 403);
  assert.equal((await put(s3.clientFetch, last.url, 11)).status, 403);
  // A changed URL does not match its signature either.
  const changed = new URL(last.url);
  changed.searchParams.set("partNumber", "1");
  assert.equal((await put(s3.clientFetch, changed.toString(), 8 * MIB)).status, 403);
  assert.equal(s3.uploads.get([...s3.uploads.keys()][0])!.parts.size, 0);
  // The right sizes are taken.
  assert.equal((await put(s3.clientFetch, first.url, 8 * MIB)).status, 200);
  assert.equal((await put(s3.clientFetch, last.url, 10)).status, 200);
  assert.equal([...s3.uploads.values()][0].parts.size, 2);
});

test("abortOtherUploads ends the replaced upload for that key only, and keeps the new one", async () => {
  const { s3, storage } = setup();
  const other = MASTER.replace(/\/[^/]+\/original$/, "/22222222-2222-4222-8222-222222222222/original");
  const old = await storage.startUpload({ key: MASTER, format: "wav", sizeBytes: MIB });
  await storage.startUpload({ key: other, format: "wav", sizeBytes: MIB });
  if (old.method !== "s3_multipart") throw new Error("method");
  assert.equal((await put(s3.clientFetch, old.parts[0].url, MIB)).status, 200);
  const next = await storage.startUpload({ key: MASTER, format: "flac", sizeBytes: 2 * MIB });
  // Starting alone ends nothing: the core ends the old one once the new one is recorded.
  assert.equal(s3.uploads.size, 3);
  await storage.abortOtherUploads(MASTER, next.providerUploadId);
  assert.deepEqual([...s3.uploads.values()].map((u) => u.key).sort(), [MASTER, other].sort());
  // The old upload's part URL now finds no upload, and its parts are gone.
  assert.equal((await put(s3.clientFetch, old.parts[0].url, MIB)).status, 404);
  const again = await storage.getUpload(MASTER, old.providerUploadId);
  if (again.method !== "s3_multipart") throw new Error("method");
  assert.deepEqual(again.completedParts, []);
  assert.deepEqual(again.parts, []);
});

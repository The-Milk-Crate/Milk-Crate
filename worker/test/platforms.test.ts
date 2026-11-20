// One run of the processing step through each platform's worker skeleton (runOneJob), with
// that platform's storage module over its test fake and its database module over the throwaway
// Postgres: the job is claimed, processed and reported through session G's job-result
// function, and the release ends in awaiting_splits or failed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeProcessRelease } from "../src/index.ts";
import { makeAudio, NEEDS_DB, processingRelease, streamKey, testDb, trackRows } from "./helpers.ts";
// Session E (Supabase).
import { supabaseStorage, MASTER_MAX_BYTES } from "../../deploy/supabase/src/storage.ts";
import { supabaseJobs } from "../../deploy/supabase/src/jobs.ts";
import { runOneJob as runOnFly } from "../../deploy/supabase/worker/run.ts";
import { applyJobResultWith as applyOnSupabase } from "../../deploy/supabase/worker/wiring.ts";
import { BASE, fakeStorage, SERVICE_KEY } from "../../deploy/supabase/test/fake-storage.ts";
import type { ClosableDatabase } from "../../deploy/supabase/src/database.ts";
// Session F (AWS).
import { s3Storage, type SignCookies } from "../../deploy/aws/src/storage.ts";
import { awsJobs } from "../../deploy/aws/src/jobs.ts";
import { runOneJob as runOnFargate } from "../../deploy/aws/worker/run.ts";
import { applyJobResultWith as applyOnAws } from "../../deploy/aws/worker/wiring.ts";
import { FakeAws } from "../../deploy/aws/test/fake-aws.ts";
import { FakeDataApi } from "../../deploy/aws/test/fake-data-api.ts";
import { dataApiDatabase } from "../../deploy/aws/src/database.ts";

const releaseState = async (db: { query: ClosableDatabase["query"] }, id: string) =>
  (await db.query<{ state: string; failure_reason: string | null }>(
    "select state, failure_reason from public.api_releases where id = $1::uuid",
    [id],
  ))[0];

describe("through session E's Fly worker skeleton, on E's storage fake", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  before(() => {
    db = testDb();
  });
  after(() => db.close());

  function setup() {
    // The buckets as 0002_buckets.sql sets them: mc-streams takes audio/mpeg only.
    const fake = fakeStorage({
      "mc-masters": { max: MASTER_MAX_BYTES, mimes: ["audio/wav", "audio/aiff", "audio/flac"] },
      "mc-streams": { max: null, mimes: ["audio/mpeg"] },
      "mc-art": { max: 20 * 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
    });
    const storage = supabaseStorage({ supabaseUrl: BASE, serviceKey: SERVICE_KEY, fetch: fake.fetch });
    const jobs = supabaseJobs({ database: db, applyResult: applyOnSupabase(db) });
    const deps = { database: db, jobs, process: makeProcessRelease({ database: db, storage, log: () => {} }), log: () => {} };
    const store = (key: string, bytes: Uint8Array, format: string) => {
      fake.objects.set(`mc-masters/${key}`, { bytes, modified: Date.now(), contentType: `audio/${format}` });
    };
    return { fake, deps, store };
  }

  test("good masters: the release moves to awaiting_splits, with the copy in mc-streams", async () => {
    const { fake, deps, store } = setup();
    const f = await processingRelease(db, [
      { format: "flac", bytes: makeAudio("flac", { seconds: 1 }) },
      { format: "wav", bytes: makeAudio("wav", { seconds: 1 }) },
    ], store);
    assert.equal(await runOnFly(deps, f.jobId), f.jobId);
    assert.deepEqual(await releaseState(db, f.releaseId), { state: "awaiting_splits", failure_reason: null });
    const rows = await trackRows(db, f.releaseId);
    assert.deepEqual(rows.map((r) => r.stream_key), [streamKey(f, 0), streamKey(f, 1)]);
    for (const r of rows) assert.equal(fake.objects.get(`mc-streams/${r.stream_key}`)!.contentType, "audio/mpeg");
  });

  test("a bad master: the release moves to failed with the plain reason, and no copy is left", async () => {
    const { fake, deps, store } = setup();
    const f = await processingRelease(db, [
      { format: "wav", bytes: makeAudio("wav", { seconds: 1 }) },
      { format: "aiff", bytes: makeAudio("flac", { seconds: 1 }) },
    ], store);
    await runOnFly(deps, f.jobId);
    assert.deepEqual(await releaseState(db, f.releaseId), {
      state: "failed",
      failure_reason: 'Track 2, "Song 2": this file is not a valid AIFF. Export it again and upload it.',
    });
    assert.deepEqual([...fake.objects.keys()].filter((k) => k.startsWith("mc-streams/")), []);
  });
});

// F's fake matches a command by its class name.
const GetObjectCommand = { name: "GetObjectCommand" };
const PutObjectCommand = { name: "PutObjectCommand" };
const ListMultipartUploadsCommand = { name: "ListMultipartUploadsCommand" };
const ListObjectsV2Command = { name: "ListObjectsV2Command" };
const DeleteObjectsCommand = { name: "DeleteObjectsCommand" };

/** An in-memory S3 at the SDK edge, for the commands storage uses here. */
function memoryS3() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const s3 = new FakeAws()
    .on(GetObjectCommand, (input) => {
      const o = objects.get(input.Key);
      if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToWebStream: () => new Response(o.bytes.slice() as Uint8Array<ArrayBuffer>).body } };
    })
    .on(PutObjectCommand, async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (bytes.length !== input.ContentLength) throw new Error("length mismatch");
      objects.set(input.Key, { bytes, contentType: input.ContentType });
      return {};
    })
    .on(ListMultipartUploadsCommand, () => ({ Uploads: [], IsTruncated: false }))
    .on(ListObjectsV2Command, (input) => ({ Contents: [...objects.keys()].filter((k) => k.startsWith(input.Prefix)).map((Key) => ({ Key })), IsTruncated: false }))
    .on(DeleteObjectsCommand, (input) => {
      for (const o of input.Delete.Objects) objects.delete(o.Key);
      return {};
    });
  return { s3, objects };
}

describe("through session F's Fargate worker skeleton, on S3 at the SDK edge and the Data API stand-in", { skip: NEEDS_DB }, () => {
  let api: FakeDataApi;
  let db: ReturnType<typeof dataApiDatabase>;
  before(() => {
    api = new FakeDataApi(process.env.MC_TEST_DB_URL!);
    db = dataApiDatabase({ client: api, resourceArn: "arn:cluster", secretArn: "arn:secret", database: "milk_crate" });
  });
  after(() => api.close());

  function setup() {
    const { s3, objects } = memoryS3();
    const storage = s3Storage({
      s3,
      presign: async () => "",
      bucket: "mc-files",
      cloudFront: { domain: "worker.invalid", keyPairId: "none", privateKey: async () => "", signCookies: (() => ({})) as SignCookies },
    });
    const jobs = awsJobs({ database: db, applyResult: applyOnAws(db) });
    const deps = { database: db, jobs, process: makeProcessRelease({ database: db, storage, log: () => {} }), log: () => {} };
    const store = (key: string, bytes: Uint8Array) => {
      objects.set(key, { bytes });
    };
    return { objects, deps, store };
  }

  test("good masters: the release moves to awaiting_splits, with the copy under streams/", async () => {
    const { objects, deps, store } = setup();
    const testDbOnPg = testDb();
    try {
      const f = await processingRelease(testDbOnPg, [
        { format: "aiff", bytes: makeAudio("aiff", { seconds: 1 }) },
        { format: "flac", bytes: makeAudio("flac", { seconds: 1 }) },
      ], store);
      assert.equal(await runOnFargate(deps, f.jobId), f.jobId);
      assert.deepEqual(await releaseState(db, f.releaseId), { state: "awaiting_splits", failure_reason: null });
      const rows = await trackRows(testDbOnPg, f.releaseId);
      assert.deepEqual(rows.map((r) => r.stream_key), [streamKey(f, 0), streamKey(f, 1)]);
      assert.deepEqual(rows.map((r) => r.duration_ms), [1000, 1000]);
      for (const r of rows) assert.equal(objects.get(r.stream_key!)!.contentType, "audio/mpeg");
    } finally {
      await testDbOnPg.close();
    }
  });

  test("a wrong SHA-256: the release moves to failed with the plain reason", async () => {
    const { objects, deps, store } = setup();
    const testDbOnPg = testDb();
    try {
      const f = await processingRelease(testDbOnPg, [
        { format: "wav", bytes: makeAudio("wav", { seconds: 1 }) },
        { format: "wav", bytes: makeAudio("wav", { seconds: 1 }), sha256: "f".repeat(64) },
      ], store);
      await runOnFargate(deps, f.jobId);
      assert.deepEqual(await releaseState(db, f.releaseId), {
        state: "failed",
        failure_reason:
          'Track 2, "Song 2": the file we received is not the one your app sent (its checksum does not match). Upload the master for this track again.',
      });
      assert.deepEqual([...objects.keys()].filter((k) => k.startsWith("streams/")), [], "track 1's copy was removed");
    } finally {
      await testDbOnPg.close();
    }
  });
});

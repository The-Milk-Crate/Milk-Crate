// For tear-down only: aborts every unfinished upload and deletes every object in the bucket.
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { get, readOutputs, region } from "./outputs.ts";

const bucket = get(readOutputs(), "Bucket");
const s3 = new S3Client({ region: region() });
let uploads = 0;
for (let more = true; more; ) {
  const out = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
  for (const u of out.Uploads ?? []) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }));
    uploads++;
  }
  more = !!out.IsTruncated;
}
let objects = 0;
for (;;) {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
  const keys = (out.Contents ?? []).map((o) => ({ Key: o.Key! }));
  if (keys.length === 0) break;
  const del = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
  if (del.Errors?.length) throw new Error(`${del.Errors.length} objects were not deleted`);
  objects += keys.length;
}
console.log(`aborted ${uploads} uploads, deleted ${objects} objects from ${bucket}`);

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
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type {
  ConfirmUploadInput,
  ConfirmUploadResult,
  ObjectKey,
  ObjectStorage,
  ReadGrantBody,
  SignReadInput,
  SignedPart,
  StartUploadInput,
  StorageUpload,
} from "./core.ts";
import { errorName, errorStatus, type Sender } from "./aws.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MASTER_KEY = new RegExp(`^masters/${ID}/${ID}/${ID}/original$`);
const COVER_KEY = new RegExp(`^art/(${ID})/(${ID})/cover/original$`);
// Session H picks the file names under a track's streams/ folder.
const STREAM_KEY = new RegExp(`^streams/(${ID})/(${ID})/(${ID})/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`);
// Delete takes a release folder or deeper, never the whole bucket or an artist (as on session E).
const DELETE_PREFIX = new RegExp(`^(masters|streams|art)/${ID}/${ID}/([A-Za-z0-9._-]+/)*$`);
// A CRC64NVME is 8 bytes: 12 characters of base64.
const CRC64NVME = /^[A-Za-z0-9+/]{11}=$/;

export const MASTER_MAX_BYTES = 5 * 1024 ** 3; // 5 GiB, the contract's largest master
export const COVER_MAX_BYTES = 20 * 1024 ** 2; // 20 MiB
const READ_HEAD_MAX_BYTES = 1024 ** 2;
const MIB = 1024 ** 2;
/** S3 allows at most 10,000 parts; every part but the last must be at least 5 MiB. */
const MAX_PARTS = 10_000;
const MIN_PART_BYTES = 8 * MIB;
/** The bucket's lifecycle rule aborts an unfinished multipart upload after this many days. */
export const UPLOAD_DAYS = 7;

const CONTENT_TYPES = {
  wav: "audio/wav",
  aiff: "audio/aiff",
  flac: "audio/flac",
  jpeg: "image/jpeg",
  png: "image/png",
} as const;

export class StorageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

/** Signs one S3 request as a URL (getSignedUrl from @aws-sdk/s3-request-presigner). */
export type Presign = (command: UploadPartCommand, expiresInSeconds: number) => Promise<string>;

/** Makes CloudFront signed cookies for a custom policy (getSignedCookies from @aws-sdk/cloudfront-signer). */
export type SignCookies = (input: { policy: string; keyPairId: string; privateKey: string }) => Record<string, string>;

export interface S3StorageOptions {
  /** An S3 client. Make it with `requestChecksumCalculation: "WHEN_REQUIRED"` (see modules.ts). */
  s3: Sender;
  presign: Presign;
  /** The one private bucket. Keys start with masters/, streams/ or art/. */
  bucket: string;
  cloudFront: {
    /** The distribution's domain, such as d111111abcdef8.cloudfront.net. */
    domain: string;
    /** The CloudFront public key id in the distribution's key group. */
    keyPairId: string;
    /** The matching private key (PEM), read when first needed (Secrets Manager). */
    privateKey: () => Promise<string>;
    signCookies: SignCookies;
  };
  /** Life of a read grant in seconds. Default 600, as on session E. */
  readTtlSeconds?: number;
  /** Life of a presigned part URL in seconds. Default 3600. */
  partTtlSeconds?: number;
  /** How many parts startUpload and getUpload sign at once. Default 50. */
  partsPerBatch?: number;
  now?: () => number;
}

export interface PartPlan {
  partSize: number;
  partCount: number;
}

/** Part size and count for a file: 8 MiB parts, larger when needed to stay within 10,000. */
export function planParts(sizeBytes: number): PartPlan {
  const partSize = Math.max(MIN_PART_BYTES, Math.ceil(sizeBytes / MAX_PARTS / MIB) * MIB);
  return { partSize, partCount: Math.max(1, Math.ceil(sizeBytes / partSize)) };
}

function partBytes(plan: PartPlan, sizeBytes: number, n: number): number {
  return n < plan.partCount ? plan.partSize : sizeBytes - plan.partSize * (plan.partCount - 1);
}

/**
 * `providerUploadId` is the S3 upload id. Its fragment records when the session started and
 * the size it was opened for (the part plan follows from the size), as on session E.
 */
export function packUploadId(s3UploadId: string, startedMs: number, sizeBytes: number): string {
  return `${s3UploadId}#mc_started=${startedMs}&mc_size=${sizeBytes}`;
}

export function unpackUploadId(id: string): { s3UploadId: string; startedMs: number; sizeBytes: number } {
  const hash = id.indexOf("#");
  const params = new URLSearchParams(hash >= 0 ? id.slice(hash + 1) : "");
  const startedMs = Number(params.get("mc_started"));
  const sizeBytes = Number(params.get("mc_size"));
  if (hash < 1 || !Number.isFinite(startedMs) || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error("not an upload id from this storage module");
  }
  return { s3UploadId: id.slice(0, hash), startedMs, sizeBytes };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function unquote(etag: string | undefined): string {
  return (etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

/**
 * `ObjectStorage` on S3 and CloudFront.
 *
 * Uploads (`s3_multipart`): the server opens a multipart upload with a full-object CRC64NVME
 * checksum and gives the client presigned part URLs. The client never gets AWS credentials,
 * and each URL allows only that one part of that one upload, for an hour.
 *
 * Reads: CloudFront signed cookies for one track's streaming folder (or one release's cover
 * folder), valid 600 seconds, plus the address to read. Never a master.
 */
export function s3Storage(options: S3StorageOptions): ObjectStorage {
  const { s3, bucket } = options;
  const now = options.now ?? Date.now;
  const readTtl = options.readTtlSeconds ?? 600;
  const partTtl = options.partTtlSeconds ?? 3600;
  const batch = options.partsPerBatch ?? 50;

  async function sign(key: string, s3UploadId: string, numbers: number[]): Promise<SignedPart[]> {
    const expiresAt = new Date(now() + partTtl * 1000).toISOString();
    return Promise.all(
      numbers.map(async (partNumber) => ({
        partNumber,
        url: await options.presign(
          new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: s3UploadId, PartNumber: partNumber }),
          partTtl,
        ),
        expiresAt,
      })),
    );
  }

  /** Every stored part of an open upload, or null when the upload is no longer open. */
  async function listParts(key: string, s3UploadId: string): Promise<{ partNumber: number; size: number; etag: string }[] | null> {
    const parts: { partNumber: number; size: number; etag: string }[] = [];
    let marker: string | undefined;
    for (;;) {
      let out;
      try {
        out = await s3.send(
          new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: s3UploadId, MaxParts: 1000, PartNumberMarker: marker }),
        );
      } catch (error) {
        if (errorName(error) === "NoSuchUpload" || errorStatus(error) === 404) return null;
        throw error;
      }
      for (const p of out.Parts ?? []) {
        parts.push({ partNumber: p.PartNumber, size: Number(p.Size ?? 0), etag: unquote(p.ETag) });
      }
      if (!out.IsTruncated) return parts;
      marker = out.NextPartNumberMarker;
    }
  }

  /** Size, last change and CRC64NVME of the stored object, or null. */
  async function objectHead(key: string): Promise<{ size: number; modifiedMs: number; crc64nvme?: string } | null> {
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
      const modified = out.LastModified instanceof Date ? out.LastModified.getTime() : Date.parse(String(out.LastModified ?? ""));
      return { size: Number(out.ContentLength ?? -1), modifiedMs: Number.isNaN(modified) ? 0 : modified, crc64nvme: out.ChecksumCRC64NVME };
    } catch (error) {
      if (errorName(error) === "NotFound" || errorName(error) === "NoSuchKey" || errorStatus(error) === 404) return null;
      throw error;
    }
  }

  /** The object at the key is the one this upload made: new enough and the size it was opened for. */
  function isThisUpload(head: { size: number; modifiedMs: number } | null, startedMs: number, sizeBytes: number): boolean {
    return !!head && head.size === sizeBytes && head.modifiedMs >= Math.floor(startedMs / 1000) * 1000;
  }

  async function session(key: string, providerUploadId: string, stored: { partNumber: number; size: number }[] | "done" | "gone"): Promise<StorageUpload> {
    const { s3UploadId, startedMs, sizeBytes } = unpackUploadId(providerUploadId);
    const plan = planParts(sizeBytes);
    const all = Array.from({ length: plan.partCount }, (_, k) => k + 1);
    if (stored === "gone") {
      // Expired (aborted by the bucket's lifecycle rule): the artist starts a new upload.
      return { method: "s3_multipart", providerUploadId, ...plan, parts: [], completedParts: [], expiresAt: new Date(now()).toISOString() };
    }
    const completedParts =
      stored === "done"
        ? all.map((n) => ({ partNumber: n, sizeBytes: partBytes(plan, sizeBytes, n) }))
        : stored.map((p) => ({ partNumber: p.partNumber, sizeBytes: p.size })).sort((a, b) => a.partNumber - b.partNumber);
    const have = new Set(completedParts.map((p) => p.partNumber));
    const missing = all.filter((n) => !have.has(n)).slice(0, batch);
    return {
      method: "s3_multipart",
      providerUploadId,
      ...plan,
      parts: stored === "done" ? [] : await sign(key, s3UploadId, missing),
      completedParts,
      expiresAt: new Date(startedMs + UPLOAD_DAYS * 86_400_000).toISOString(),
    };
  }

  async function getUpload(key: ObjectKey, providerUploadId: string): Promise<StorageUpload> {
    const { s3UploadId, startedMs, sizeBytes } = unpackUploadId(providerUploadId);
    const parts = await listParts(key, s3UploadId);
    if (parts) return session(key, providerUploadId, parts);
    return session(key, providerUploadId, isThisUpload(await objectHead(key), startedMs, sizeBytes) ? "done" : "gone");
  }

  return {
    async startUpload(input: StartUploadInput): Promise<StorageUpload> {
      const { key, format, sizeBytes } = input;
      if (MASTER_KEY.test(key)) {
        if (!["wav", "aiff", "flac"].includes(format)) throw new Error("a master is WAV, AIFF or FLAC");
        if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MASTER_MAX_BYTES) {
          throw new Error("a master is 1 byte to 5 GiB");
        }
      } else if (COVER_KEY.test(key)) {
        if (!["jpeg", "png"].includes(format)) throw new Error("a cover is JPEG or PNG");
        if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > COVER_MAX_BYTES) {
          throw new Error("a cover is 1 byte to 20 MiB");
        }
      } else {
        throw new Error(`uploads go only to a master or cover key, not ${key}`);
      }
      const started = now();
      const created = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: CONTENT_TYPES[format],
          // S3 checks the whole file's CRC64NVME when the upload completes.
          ChecksumAlgorithm: "CRC64NVME",
          ChecksumType: "FULL_OBJECT",
        }),
      );
      if (!created.UploadId) throw new StorageError(502, "S3 returned no upload id");
      return session(key, packUploadId(created.UploadId, started, sizeBytes), []);
    },

    getUpload,

    async signParts(key: ObjectKey, providerUploadId: string, partNumbers: number[]): Promise<SignedPart[]> {
      const { s3UploadId, sizeBytes } = unpackUploadId(providerUploadId);
      const { partCount } = planParts(sizeBytes);
      if (partNumbers.length < 1 || partNumbers.length > 1000) throw new Error("ask for 1 to 1000 parts");
      for (const n of partNumbers) {
        if (!Number.isInteger(n) || n < 1 || n > partCount) throw new Error(`this upload has parts 1 to ${partCount}, not ${n}`);
      }
      return sign(key, s3UploadId, [...new Set(partNumbers)]);
    },

    async confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResult> {
      // The SHA-256 is not checked here: an S3 multipart SHA-256 is a checksum of the parts, so
      // it can never equal the client's whole-file SHA-256. The worker checks it while it
      // streams the master (session H). Here: every part, the stored size and the CRC64NVME.
      if (!input.crc64nvme || !CRC64NVME.test(input.crc64nvme) || !input.parts?.length) {
        throw new StorageError(400, "an s3_multipart upload is confirmed with crc64nvme and its parts");
      }
      const { s3UploadId, startedMs, sizeBytes } = unpackUploadId(input.providerUploadId);
      const plan = planParts(sizeBytes);
      const stored = await listParts(input.key, s3UploadId);

      if (stored) {
        const byNumber = new Map(stored.map((p) => [p.partNumber, p]));
        for (let n = 1; n <= plan.partCount; n++) if (!byNumber.has(n)) return { ok: false, reason: "incomplete" };
        if (stored.length !== plan.partCount) return { ok: false, reason: "checksum_mismatch" };
        const sent = new Map(input.parts.map((p) => [p.partNumber, unquote(p.etag)]));
        if (sent.size !== plan.partCount || input.parts.length !== plan.partCount) return { ok: false, reason: "checksum_mismatch" };
        for (const p of stored) if (sent.get(p.partNumber) !== p.etag) return { ok: false, reason: "checksum_mismatch" };
        if (stored.reduce((sum, p) => sum + p.size, 0) !== sizeBytes) return { ok: false, reason: "checksum_mismatch" };
        try {
          await s3.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: input.key,
              UploadId: s3UploadId,
              ChecksumCRC64NVME: input.crc64nvme,
              ChecksumType: "FULL_OBJECT",
              MultipartUpload: {
                Parts: stored
                  .sort((a, b) => a.partNumber - b.partNumber)
                  .map((p) => ({ PartNumber: p.partNumber, ETag: `"${p.etag}"` })),
              },
            }),
          );
        } catch (error) {
          const name = errorName(error);
          // A wrong CRC64NVME: S3 refuses to complete and the upload stays open.
          if (name === "BadDigest" || name === "InvalidDigest" || name === "InvalidPart" || name === "InvalidPartOrder") {
            return { ok: false, reason: "checksum_mismatch" };
          }
          if (name === "InvalidRequest" && /checksum/i.test((error as Error).message ?? "")) {
            return { ok: false, reason: "checksum_mismatch" };
          }
          if (name !== "NoSuchUpload") throw error;
        }
      }

      // Completed now, or by an earlier confirm whose answer was lost: check what is stored.
      const head = await objectHead(input.key);
      if (!head || head.modifiedMs < Math.floor(startedMs / 1000) * 1000) return { ok: false, reason: "incomplete" };
      if (head.size !== sizeBytes || head.crc64nvme !== input.crc64nvme) return { ok: false, reason: "checksum_mismatch" };
      return { ok: true };
    },

    async readHead(key: ObjectKey, maxBytes: number): Promise<Uint8Array> {
      const limit = Math.max(1, Math.min(Math.floor(maxBytes), READ_HEAD_MAX_BYTES));
      let out;
      try {
        out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${limit - 1}` }));
      } catch (error) {
        const name = errorName(error);
        if (name === "NoSuchKey" || name === "NotFound" || errorStatus(error) === 404) throw new StorageError(404, `no object at ${key}`);
        // An empty object has no byte 0.
        if (name === "InvalidRange" || errorStatus(error) === 416) return new Uint8Array(0);
        throw error;
      }
      if (!out.Body) return new Uint8Array(0);
      const bytes: Uint8Array = await out.Body.transformToByteArray();
      // Stop at the limit even if a range was ignored.
      return bytes.slice(0, limit);
    },

    async signRead(input: SignReadInput): Promise<ReadGrantBody> {
      // Only streaming copies and covers. Never a master.
      const stream = STREAM_KEY.exec(input.key);
      const cover = COVER_KEY.exec(input.key);
      if (!stream && !cover) throw new Error(`signRead signs only streams/ and cover keys, not ${input.key}`);
      // The cookies cover one track's streaming folder, or one release's cover folder.
      const scope = stream
        ? `streams/${stream[1]}/${stream[2]}/${stream[3]}/`
        : `art/${cover![1]}/${cover![2]}/cover/`;
      if (!(await objectHead(input.key))) throw new StorageError(404, `no object at ${input.key}`);
      // Signed cookies cannot carry the listener: whoever holds them can read that folder until
      // they expire, as with session E's signed links. Each call makes fresh ones for 600 s;
      // input.userId is not part of them (settled; the contract says so).
      const expires = Math.floor(now() / 1000) + readTtl;
      const domain = options.cloudFront.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const policy = JSON.stringify({
        Statement: [
          { Resource: `https://${domain}/${encodeKey(scope)}*`, Condition: { DateLessThan: { "AWS:EpochTime": expires } } },
        ],
      });
      const cookies = options.cloudFront.signCookies({
        policy,
        keyPairId: options.cloudFront.keyPairId,
        privateKey: await options.cloudFront.privateKey(),
      });
      return {
        method: "cloudfront_cookies",
        streamUrl: `https://${domain}/${encodeKey(input.key)}`,
        cookies: Object.entries(cookies).map(([name, value]) => ({ name, value: String(value) })),
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },

    async delete(prefix: ObjectKey): Promise<void> {
      if (!DELETE_PREFIX.test(prefix)) throw new Error(`delete takes a release folder ending in /, not ${prefix}`);
      // Unfinished uploads under the prefix first, so no part outlives the takedown.
      let keyMarker: string | undefined;
      let idMarker: string | undefined;
      for (;;) {
        const out = await s3.send(
          new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: idMarker }),
        );
        for (const u of out.Uploads ?? []) {
          try {
            await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }));
          } catch (error) {
            if (errorName(error) !== "NoSuchUpload") throw error;
          }
        }
        if (!out.IsTruncated) break;
        keyMarker = out.NextKeyMarker;
        idMarker = out.NextUploadIdMarker;
      }

      const keys = await listKeys(prefix);
      for (let i = 0; i < keys.length; i += 1000) {
        const out = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (out.Errors?.length) {
          throw new StorageError(500, `${out.Errors.length} objects under ${prefix} were not deleted: ${out.Errors[0].Code ?? ""}`);
        }
      }
      const left = await listKeys(prefix);
      if (left.length > 0) throw new StorageError(500, `${left.length} objects under ${prefix} were not deleted`);
    },
  };

  async function listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}

// Test only: an in-memory S3 bucket at the SDK edge (session F's FakeAws), with the commands
// F's storage module sends, plus the two HTTP edges a client reaches: a presigned part URL
// (PUT, answers an ETag; the signature is checked with the body's real length, so a part of
// the wrong size is refused as S3 refuses it) and CloudFront (GET, served only with valid signed cookies whose
// policy covers the address, as CloudFront checks them). F's own tests answer one command at a
// time; this keeps state so a whole scenario can run through it.
import { createHash, createHmac, createVerify } from "node:crypto";
import { crc64nvme } from "../../../deploy/aws/src/crc64nvme.ts";
import { FakeAws, awsError } from "../../../deploy/aws/test/fake-aws.ts";

const cmd = (name: string) => ({ name });

interface Upload {
  key: string;
  contentType?: string;
  parts: Map<number, { bytes: Uint8Array; etag: string; modified: number }>;
}

export interface S3Object {
  bytes: Uint8Array;
  modified: number;
  contentType?: string;
  crc64nvme?: string;
}

/** RFC 3986 encoding, as SigV4 wants it. */
const sigEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * S3's check of a presigned (query string) SigV4 request: the signature recomputed from the
 * request as it arrived, with `content-length` taken from the real body. A URL signed for
 * another length, or a changed URL, does not match.
 */
function presignedSignatureOk(url: URL, method: string, headers: Headers, bodyLength: number, secretAccessKey: string): boolean {
  const q = url.searchParams;
  if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return false;
  const signature = q.get("X-Amz-Signature") ?? "";
  const date = q.get("X-Amz-Date") ?? "";
  const [, scopeDate, region, service] = (q.get("X-Amz-Credential") ?? "").split("/");
  const signedHeaders = (q.get("X-Amz-SignedHeaders") ?? "").split(";");
  const value = (name: string) => (name === "host" ? url.host : name === "content-length" ? String(bodyLength) : (headers.get(name) ?? "").trim());
  const query = [...q.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .map(([k, v]) => [sigEncode(k), sigEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [method, url.pathname, query, signedHeaders.map((h) => `${h}:${value(h)}\n`).join(""), signedHeaders.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${scopeDate}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${secretAccessKey}`).update(scopeDate).digest();
  for (const part of [region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex") === signature;
}

export function fakeS3(options: {
  bucket: string;
  region: string;
  cloudFrontDomain: string;
  cloudFrontPublicKeyPem: string;
  keyPairId: string;
  /** The presigner's made-up secret key, to check part URL signatures as S3 does. */
  secretAccessKey: string;
}) {
  const objects = new Map<string, S3Object>();
  const uploads = new Map<string, Upload>();
  let n = 0;
  // S3 keeps LastModified to the second.
  const nowSecond = () => Math.floor(Date.now() / 1000) * 1000;
  const noSuchUpload = () => awsError("NoSuchUpload", "The specified upload does not exist.", 404);
  const noSuchKey = () => awsError("NoSuchKey", "The specified key does not exist.", 404);

  const s3 = new FakeAws()
    .on(cmd("CreateMultipartUploadCommand"), (input) => {
      const id = `mpu-${++n}`;
      uploads.set(id, { key: input.Key, contentType: input.ContentType, parts: new Map() });
      return { UploadId: id, Bucket: input.Bucket, Key: input.Key };
    })
    .on(cmd("ListPartsCommand"), (input) => {
      const u = uploads.get(input.UploadId);
      if (!u || u.key !== input.Key) throw noSuchUpload();
      const all = [...u.parts.entries()].sort((a, b) => a[0] - b[0]);
      const after = Number(input.PartNumberMarker ?? 0);
      const page = all.filter(([k]) => k > after).slice(0, input.MaxParts ?? 1000);
      const last = page.at(-1)?.[0];
      return {
        Parts: page.map(([k, p]) => ({ PartNumber: k, Size: p.bytes.length, ETag: `"${p.etag}"` })),
        IsTruncated: last !== undefined && all.some(([k]) => k > last),
        NextPartNumberMarker: last === undefined ? undefined : String(last),
      };
    })
    .on(cmd("CompleteMultipartUploadCommand"), (input) => {
      const u = uploads.get(input.UploadId);
      if (!u || u.key !== input.Key) throw noSuchUpload();
      const listed = input.MultipartUpload?.Parts ?? [];
      const chunks: Uint8Array[] = [];
      for (const p of listed) {
        const stored = u.parts.get(p.PartNumber);
        if (!stored || `"${stored.etag}"` !== p.ETag) throw awsError("InvalidPart", "One or more of the specified parts could not be found.", 400);
        chunks.push(stored.bytes);
      }
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const crc = crc64nvme(bytes);
      if (input.ChecksumCRC64NVME !== crc) throw awsError("BadDigest", "The CRC64NVME you specified did not match the calculated checksum.", 400);
      objects.set(input.Key, { bytes, modified: nowSecond(), contentType: u.contentType, crc64nvme: crc });
      uploads.delete(input.UploadId);
      return { ChecksumCRC64NVME: crc };
    })
    .on(cmd("AbortMultipartUploadCommand"), (input) => {
      if (!uploads.delete(input.UploadId)) throw noSuchUpload();
      return {};
    })
    .on(cmd("ListMultipartUploadsCommand"), (input) => ({
      Uploads: [...uploads.entries()].filter(([, u]) => u.key.startsWith(input.Prefix ?? "")).map(([id, u]) => ({ Key: u.key, UploadId: id })),
      IsTruncated: false,
    }))
    .on(cmd("HeadObjectCommand"), (input) => {
      const o = objects.get(input.Key);
      if (!o) throw awsError("NotFound", "Not Found", 404);
      return {
        ContentLength: o.bytes.length,
        LastModified: new Date(o.modified),
        ...(input.ChecksumMode === "ENABLED" && o.crc64nvme ? { ChecksumCRC64NVME: o.crc64nvme } : {}),
      };
    })
    .on(cmd("GetObjectCommand"), (input) => {
      const o = objects.get(input.Key);
      if (!o) throw noSuchKey();
      let bytes = o.bytes;
      const range = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? "");
      if (range) {
        if (bytes.length === 0) throw awsError("InvalidRange", "The requested range is not satisfiable", 416);
        bytes = bytes.slice(Number(range[1]), Number(range[2]) + 1);
      }
      return {
        Body: {
          transformToByteArray: async () => bytes.slice(),
          transformToWebStream: () => new Response(bytes.slice() as Uint8Array<ArrayBuffer>).body,
        },
      };
    })
    .on(cmd("PutObjectCommand"), async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (bytes.length !== input.ContentLength) throw awsError("IncompleteBody", "length mismatch", 400);
      objects.set(input.Key, { bytes, modified: nowSecond(), contentType: input.ContentType, crc64nvme: crc64nvme(bytes) });
      return {};
    })
    .on(cmd("ListObjectsV2Command"), (input) => ({
      Contents: [...objects.keys()].filter((k) => k.startsWith(input.Prefix ?? "")).sort().map((Key) => ({ Key })),
      IsTruncated: false,
    }))
    .on(cmd("DeleteObjectsCommand"), (input) => {
      for (const o of input.Delete.Objects) objects.delete(o.Key);
      return { Deleted: input.Delete.Objects };
    });

  const s3Host = `${options.bucket}.s3.${options.region}.amazonaws.com`;

  /** CloudFront's check of signed cookies with a custom policy. */
  function cookiesAllow(cookieHeader: string, url: URL): boolean {
    const cookies = Object.fromEntries(
      cookieHeader.split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
    );
    const policyB64 = cookies["CloudFront-Policy"];
    const signature = cookies["CloudFront-Signature"];
    if (!policyB64 || !signature || cookies["CloudFront-Key-Pair-Id"] !== options.keyPairId) return false;
    // CloudFront's URL-safe base64: + becomes -, = becomes _, / becomes ~.
    const unsafe = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");
    const policy = unsafe(policyB64).toString("utf8");
    const verify = createVerify("RSA-SHA1");
    verify.update(policy);
    if (!verify.verify(options.cloudFrontPublicKeyPem, unsafe(signature))) return false;
    const statement = JSON.parse(policy).Statement?.[0];
    const resource: string = statement?.Resource ?? "";
    const expires = Number(statement?.Condition?.DateLessThan?.["AWS:EpochTime"]);
    if (!(expires * 1000 > Date.now())) return false;
    const target = `${url.origin}${url.pathname}`;
    return resource.endsWith("*") ? target.startsWith(resource.slice(0, -1)) : target === resource;
  }

  /** The client's side: presigned part PUTs and CloudFront reads. */
  const clientFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === s3Host && req.method === "PUT") {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const partNumber = Number(url.searchParams.get("partNumber"));
      const key = decodeURIComponent(url.pathname.slice(1));
      if (!url.searchParams.get("X-Amz-Signature")) return new Response("AccessDenied", { status: 403 });
      const expires = Date.parse(
        (url.searchParams.get("X-Amz-Date") ?? "").replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
      ) + Number(url.searchParams.get("X-Amz-Expires")) * 1000;
      if (!(expires > Date.now())) return new Response("Request has expired", { status: 403 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      // F signs each part's planned size (content-length), so a body of another length fails here.
      if (!(url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").includes("content-length")) {
        return new Response("the part URL does not sign content-length", { status: 403 });
      }
      if (!presignedSignatureOk(url, req.method, req.headers, bytes.length, options.secretAccessKey)) {
        return new Response("SignatureDoesNotMatch", { status: 403 });
      }
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) return new Response("NoSuchUpload", { status: 404 });
      const etag = createHash("md5").update(bytes).digest("hex");
      u.parts.set(partNumber, { bytes, etag, modified: Date.now() });
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
    }
    if (url.host === options.cloudFrontDomain && req.method === "GET") {
      if (!cookiesAllow(req.headers.get("cookie") ?? "", url)) return new Response("AccessDenied", { status: 403 });
      const key = decodeURIComponent(url.pathname.slice(1));
      // The distribution's origin path: only streams/ and art/ are behind CloudFront.
      const o = /^(streams|art)\//.test(key) ? objects.get(key) : undefined;
      if (!o) return new Response("NoSuchKey", { status: 404 });
      return new Response(o.bytes.slice() as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": o.contentType ?? "application/octet-stream" } });
    }
    return new Response(`the fake has no route for ${req.method} ${url.host}${url.pathname}`, { status: 501 });
  }) as typeof fetch;

  return { s3, objects, uploads, clientFetch };
}

// A small client for the contract, shared by the mock runs and run-live.ts. It builds each
// request from the contract's own path for the operation, so a path change in the contract
// shows up here. Uploads follow whichever branch the deployment answered (tus or s3_multipart).
import { crc64nvme } from "../../../deploy/aws/src/crc64nvme.ts";
import { tusSend } from "../../../deploy/supabase/test/fake-storage.ts";
import { loadContract } from "./contract.ts";

export interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

export interface CallInput {
  /** A bearer token, or null for none. */
  token?: string | null;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** Sent as is, instead of `body`. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export class Api {
  readonly base: string;
  readonly fetchFn: typeof fetch;
  /**
   * @param base The deployment's base address; the contract's path (/v1/...) goes after it.
   * @param fetchFn fetch, or a stand-in that reaches a mock deployment.
   */
  constructor(base: string, fetchFn: typeof fetch = fetch) {
    this.base = base;
    this.fetchFn = fetchFn;
  }

  async call(operationId: string, input: CallInput = {}): Promise<Reply> {
    const op = loadContract().operations[operationId];
    if (!op) throw new Error(`no operation ${operationId} in the contract`);
    let path = op.path;
    for (const [k, v] of Object.entries(input.params ?? {})) path = path.replace(`{${k}}`, encodeURIComponent(v));
    if (/\{[A-Za-z]+\}/.test(path)) throw new Error(`${operationId}: a path parameter is missing in ${path}`);
    const url = new URL(this.base.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    let body: string | undefined;
    if (input.rawBody !== undefined) {
      body = input.rawBody;
      headers["content-type"] ??= "application/json";
    } else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers["content-type"] = "application/json";
    }
    const response = await this.fetchFn(url, { method: op.method, headers, body });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { notJson: text.slice(0, 200) };
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Buffer.from(digest).toString("hex");
}

/** One part of an s3_multipart upload, PUT to its presigned URL. Returns the ETag. */
export async function s3PutPart(
  fetchFn: typeof fetch,
  part: { partNumber: number; url: string; headers?: Record<string, string> },
  bytes: Uint8Array,
): Promise<string> {
  const response = await fetchFn(part.url, { method: "PUT", headers: { ...(part.headers ?? {}) }, body: bytes as Uint8Array<ArrayBuffer> });
  if (!response.ok) throw new Error(`part ${part.partNumber}: PUT answered ${response.status}`);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error(`part ${part.partNumber}: no ETag (the bucket's CORS must expose it)`);
  return etag.replace(/^"|"$/g, "");
}

/** The bytes of part n (1-based) of an s3_multipart session. */
export function partBytes(session: { partSize: number; partCount: number }, bytes: Uint8Array, n: number): Uint8Array {
  return bytes.slice((n - 1) * session.partSize, n === session.partCount ? bytes.length : n * session.partSize);
}

export interface UploadPlan {
  /** Stop after this many bytes (tus) or this many parts (s3_multipart): an interruption. */
  stopAfter?: { bytes?: number; parts?: number };
}

/** What a client remembers about the parts it sent (s3_multipart only). */
export type SentParts = Map<number, string>;

/**
 * Sends the file for an upload session, or the rest of it: for tus from `session.offset`, for
 * s3_multipart every part not in `completedParts` (signing more with signUploadParts when the
 * session's list runs out). Returns the parts sent so far (s3_multipart), for the confirm.
 */
export async function sendFile(
  api: Api,
  token: string,
  uploadFetch: typeof fetch,
  session: any,
  bytes: Uint8Array,
  sent: SentParts = new Map(),
  plan: UploadPlan = {},
): Promise<SentParts> {
  if (session.method === "tus") {
    const to = plan.stopAfter?.bytes !== undefined ? Math.min(bytes.length, plan.stopAfter.bytes) : bytes.length;
    let at = session.offset as number;
    // Supabase's TUS takes chunks of 6 MiB.
    const chunk = 6 * 1024 * 1024;
    while (at < to) at = await tusSend(uploadFetch, session, bytes, at, Math.min(to, at + chunk));
    return sent;
  }
  if (session.method !== "s3_multipart") throw new Error(`unknown upload method ${session.method}`);
  const done = new Set<number>((session.completedParts as { partNumber: number }[]).map((p) => p.partNumber));
  const signed = new Map<number, any>((session.parts as any[]).map((p) => [p.partNumber, p]));
  let count = 0;
  for (let n = 1; n <= session.partCount; n++) {
    if (done.has(n)) continue;
    if (plan.stopAfter?.parts !== undefined && count >= plan.stopAfter.parts) break;
    let part = signed.get(n);
    if (!part) {
      const more = await api.call("signUploadParts", { token, params: { uploadId: session.uploadId }, body: { partNumbers: [n] } });
      if (more.status !== 200) throw new Error(`signUploadParts answered ${more.status}`);
      part = more.body.parts[0];
    }
    sent.set(n, await s3PutPart(uploadFetch, part, partBytes(session, bytes, n)));
    count++;
  }
  return sent;
}

/** The confirm body the contract asks for: the SHA-256, and on S3 the CRC64NVME and the parts. */
export async function confirmBody(method: string, bytes: Uint8Array, sent: SentParts, sha256?: string) {
  const body: Record<string, unknown> = { sha256: sha256 ?? (await sha256Hex(bytes)) };
  if (method === "s3_multipart") {
    body.crc64nvme = crc64nvme(bytes);
    body.parts = [...sent.entries()].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag }));
  }
  return body;
}

/** Reads what a read grant points at (a signed URL, or the stream address with the cookies). */
export async function readGrant(fetchFn: typeof fetch, grant: any): Promise<Response> {
  if (grant.method === "signed_url") return fetchFn(grant.url);
  if (grant.method === "cloudfront_cookies") {
    const cookie = (grant.cookies as { name: string; value: string }[]).map((c) => `${c.name}=${c.value}`).join("; ");
    return fetchFn(grant.streamUrl, { headers: { cookie } });
  }
  throw new Error(`unknown grant method ${grant.method}`);
}

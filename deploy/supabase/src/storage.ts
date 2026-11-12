import { serviceHeaders } from "./env.ts";
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

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MASTER_KEY = new RegExp(`^masters/${ID}/${ID}/${ID}/original$`);
const COVER_KEY = new RegExp(`^art/${ID}/${ID}/cover/original$`);
// Session H picks the file names under a track's streams/ folder.
const STREAM_KEY = new RegExp(`^streams/${ID}/${ID}/${ID}/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`);
// Delete takes a release folder or deeper, never a whole bucket or artist.
const DELETE_PREFIX = new RegExp(`^(masters|streams|art)/${ID}/${ID}/([A-Za-z0-9._-]+/)*$`);

export const MASTER_MAX_BYTES = 5 * 1024 ** 3; // 5 GiB
export const COVER_MAX_BYTES = 20 * 1024 ** 2; // 20 MiB
const READ_HEAD_MAX_BYTES = 1024 ** 2;

const CONTENT_TYPES = {
  wav: "audio/wav",
  aiff: "audio/aiff",
  flac: "audio/flac",
  jpeg: "image/jpeg",
  png: "image/png",
} as const;

export interface Buckets {
  /** masters/... (private, 5 GiB, WAV, AIFF, FLAC). */
  masters: string;
  /** streams/... (private). */
  streams: string;
  /** art/... (private, 20 MiB, JPEG, PNG). */
  art: string;
}

export const DEFAULT_BUCKETS: Buckets = { masters: "mc-masters", streams: "mc-streams", art: "mc-art" };

export interface SupabaseStorageOptions {
  /** https://<ref>.supabase.co */
  supabaseUrl: string;
  /**
   * Where clients send TUS uploads. Supabase advises the direct storage host for large files:
   * https://<ref>.storage.supabase.co. Defaults to supabaseUrl.
   */
  storageUrl?: string;
  /** The server's secret key (service role). Never sent to a client. */
  serviceKey: string;
  /** The publishable (anon) key, sent to clients as `apikey` with their TUS requests. Public. */
  publishableKey?: string;
  buckets?: Buckets;
  /** Life of a signed read in seconds. Default 600. */
  readTtlSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class StorageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** The expiry of a Supabase signed token (a JWT), without checking it. */
function tokenExpiry(token: string, fallbackMs: number): number {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "="))).exp;
    return typeof exp === "number" ? exp * 1000 : fallbackMs;
  } catch {
    return fallbackMs;
  }
}

/**
 * `providerUploadId` is the TUS upload URL. Its fragment (never sent to a server) records when
 * the session started and the size it was opened for, which confirm needs.
 */
function packUploadId(uploadUrl: string, startedMs: number, sizeBytes: number): string {
  return `${uploadUrl}#mc_started=${startedMs}&mc_size=${sizeBytes}`;
}

function unpackUploadId(id: string): { uploadUrl: string; startedMs: number; sizeBytes: number } {
  const hash = id.indexOf("#");
  const params = new URLSearchParams(hash >= 0 ? id.slice(hash + 1) : "");
  const startedMs = Number(params.get("mc_started"));
  const sizeBytes = Number(params.get("mc_size"));
  if (hash < 0 || !Number.isFinite(startedMs) || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error("not an upload id from this storage module");
  }
  return { uploadUrl: id.slice(0, hash), startedMs, sizeBytes };
}

/**
 * `ObjectStorage` on Supabase Storage. Three private buckets, one per top-level folder; the
 * object name inside a bucket is the whole key.
 *
 * Uploads: the server opens a TUS upload with the size fixed (`Upload-Length`) and gives the
 * client the upload URL and a signed upload token (`x-signature`). The client never gets the
 * secret key, and the token only allows that one object.
 */
export function supabaseStorage(options: SupabaseStorageOptions): ObjectStorage {
  const api = `${options.supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
  const tusApi = `${(options.storageUrl ?? options.supabaseUrl).replace(/\/+$/, "")}/storage/v1`;
  const buckets = options.buckets ?? DEFAULT_BUCKETS;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.readTtlSeconds ?? 600;
  const auth = serviceHeaders(options.serviceKey);

  function bucketOf(key: string): string {
    const top = key.split("/")[0];
    if (top === "masters") return buckets.masters;
    if (top === "streams") return buckets.streams;
    if (top === "art") return buckets.art;
    throw new Error(`not a Milk Crate key: ${key}`);
  }

  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    const response = await doFetch(url, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    if (!response.ok && response.status !== 404 && response.status !== 410 && response.status !== 416) {
      const body = await response.text().catch(() => "");
      throw new StorageError(response.status, `${what} failed (${response.status}): ${body.slice(0, 200)}`);
    }
    return response;
  }

  /** A signed upload token for one object, valid about two hours. Allows replacing it. */
  async function signUpload(key: string): Promise<{ token: string; expiresMs: number }> {
    const response = await call(
      `${api}/object/upload/sign/${bucketOf(key)}/${encodeKey(key)}`,
      { method: "POST", headers: { "content-type": "application/json", "x-upsert": "true" }, body: "{}" },
      "signing the upload",
    );
    if (!response.ok) throw new StorageError(response.status, "signing the upload failed");
    const { url } = (await response.json()) as { url: string };
    const token = new URL(url, "http://x").searchParams.get("token");
    if (!token) throw new StorageError(502, "signing the upload returned no token");
    return { token, expiresMs: tokenExpiry(token, now() + 2 * 3600 * 1000) };
  }

  function clientHeaders(token: string): Record<string, string> {
    return {
      "x-signature": token,
      "x-upsert": "true",
      ...(options.publishableKey ? { apikey: options.publishableKey } : {}),
    };
  }

  /** Bytes stored so far by the TUS upload, or null when the upload is gone (done or expired). */
  async function tusProgress(uploadUrl: string, token: string): Promise<{ offset: number; length: number } | null> {
    const response = await call(
      uploadUrl,
      { method: "HEAD", headers: { "tus-resumable": "1.0.0", "x-signature": token } },
      "reading the upload",
    );
    if (response.status === 404 || response.status === 410) return null;
    const offset = Number(response.headers.get("upload-offset"));
    const length = Number(response.headers.get("upload-length"));
    if (!Number.isInteger(offset) || !Number.isInteger(length)) {
      throw new StorageError(502, "the upload has no Upload-Offset or Upload-Length");
    }
    return { offset, length };
  }

  /** Size and last change of a stored object, or null. */
  async function objectHead(key: string): Promise<{ size: number; modifiedMs: number } | null> {
    const response = await call(
      `${api}/object/authenticated/${bucketOf(key)}/${encodeKey(key)}`,
      { method: "HEAD" },
      "reading the object",
    );
    if (response.status === 404 || response.status === 410) return null;
    const size = Number(response.headers.get("content-length"));
    const modified = Date.parse(response.headers.get("last-modified") ?? "");
    return { size, modifiedMs: Number.isNaN(modified) ? 0 : modified };
  }

  function tusSession(id: string, token: string, offset: number, expiresMs: number): StorageUpload {
    return {
      method: "tus",
      providerUploadId: id,
      endpoint: unpackUploadId(id).uploadUrl,
      headers: clientHeaders(token),
      offset,
      expiresAt: new Date(expiresMs).toISOString(),
    };
  }

  return {
    async startUpload(input: StartUploadInput): Promise<StorageUpload> {
      const { key, format, sizeBytes } = input;
      const isMaster = MASTER_KEY.test(key);
      const isCover = COVER_KEY.test(key);
      if (isMaster) {
        if (!["wav", "aiff", "flac"].includes(format)) throw new Error("a master is WAV, AIFF or FLAC");
        if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MASTER_MAX_BYTES) {
          throw new Error("a master is 1 byte to 5 GiB");
        }
      } else if (isCover) {
        if (!["jpeg", "png"].includes(format)) throw new Error("a cover is JPEG or PNG");
        if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > COVER_MAX_BYTES) {
          throw new Error("a cover is 1 byte to 20 MiB");
        }
      } else {
        throw new Error(`uploads go only to a master or cover key, not ${key}`);
      }

      const started = now();
      const { token, expiresMs } = await signUpload(key);
      const created = await call(
        `${tusApi}/upload/resumable/sign`,
        {
          method: "POST",
          headers: {
            "tus-resumable": "1.0.0",
            "upload-length": String(sizeBytes),
            "upload-metadata": [
              `bucketName ${b64(bucketOf(key))}`,
              `objectName ${b64(key)}`,
              `contentType ${b64(CONTENT_TYPES[format])}`,
              `cacheControl ${b64("3600")}`,
            ].join(","),
            "x-signature": token,
            "x-upsert": "true",
          },
        },
        "opening the upload",
      );
      const location = created.headers.get("location");
      if (created.status !== 201 || !location) {
        throw new StorageError(created.status, "opening the upload returned no Location");
      }
      const uploadUrl = new URL(location, `${tusApi}/upload/resumable/sign`).toString();
      return tusSession(packUploadId(uploadUrl, started, sizeBytes), token, 0, expiresMs);
    },

    async getUpload(key: ObjectKey, providerUploadId: string): Promise<StorageUpload> {
      const { uploadUrl, startedMs, sizeBytes } = unpackUploadId(providerUploadId);
      const { token, expiresMs } = await signUpload(key);
      const progress = await tusProgress(uploadUrl, token);
      if (progress) return tusSession(providerUploadId, token, progress.offset, expiresMs);
      // The TUS upload is gone. Either it finished (the object is there, new enough and the
      // right size) or it expired, and the artist starts a new upload.
      const head = await objectHead(key);
      if (head && head.size === sizeBytes && head.modifiedMs >= Math.floor(startedMs / 1000) * 1000) {
        return tusSession(providerUploadId, token, sizeBytes, expiresMs);
      }
      return tusSession(providerUploadId, token, 0, now());
    },

    async signParts(): Promise<SignedPart[]> {
      throw new Error("signParts is for s3_multipart; Supabase uploads use tus");
    },

    async confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResult> {
      // The SHA-256 is not checked here: Supabase Storage keeps none and an Edge Function
      // cannot hash 5 GiB. The worker checks it while it streams the master (session H).
      const { uploadUrl, startedMs, sizeBytes } = unpackUploadId(input.providerUploadId);
      const { token } = await signUpload(input.key);
      const progress = await tusProgress(uploadUrl, token);
      if (progress && progress.offset < progress.length) return { ok: false, reason: "incomplete" };
      const head = await objectHead(input.key);
      // No object yet, or only an older one at the same key (a master being replaced).
      if (!head || head.modifiedMs < Math.floor(startedMs / 1000) * 1000) return { ok: false, reason: "incomplete" };
      if (head.size !== sizeBytes) return { ok: false, reason: "checksum_mismatch" };
      return { ok: true };
    },

    async readHead(key: ObjectKey, maxBytes: number): Promise<Uint8Array> {
      const limit = Math.max(1, Math.min(Math.floor(maxBytes), READ_HEAD_MAX_BYTES));
      const response = await call(
        `${api}/object/authenticated/${bucketOf(key)}/${encodeKey(key)}`,
        { method: "GET", headers: { range: `bytes=0-${limit - 1}` } },
        "reading the object",
      );
      if (response.status === 404 || response.status === 410) throw new StorageError(404, `no object at ${key}`);
      if (response.status === 416 || !response.body) return new Uint8Array(0);
      // Stop at the limit even if the server ignored the range.
      const out = new Uint8Array(limit);
      let filled = 0;
      const reader = response.body.getReader();
      while (filled < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, limit - filled);
        out.set(value.subarray(0, take), filled);
        filled += take;
      }
      await reader.cancel().catch(() => {});
      return out.slice(0, filled);
    },

    async signRead(input: SignReadInput): Promise<ReadGrantBody> {
      // Only streaming copies and covers. Never a master.
      if (!STREAM_KEY.test(input.key) && !COVER_KEY.test(input.key)) {
        throw new Error(`signRead signs only streams/ and cover keys, not ${input.key}`);
      }
      // Supabase signed URLs cannot carry the listener: anyone holding the link can read it
      // until it expires. Each call makes a fresh link with a short life; input.userId is not
      // part of it. (An open point in the pull request.)
      const response = await call(
        `${api}/object/sign/${bucketOf(input.key)}/${encodeKey(input.key)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: ttl }) },
        "signing the read",
      );
      if (!response.ok) throw new StorageError(404, `no object at ${input.key}`);
      const { signedURL } = (await response.json()) as { signedURL: string };
      return {
        method: "signed_url",
        url: new URL(`${api}${signedURL.startsWith("/") ? "" : "/"}${signedURL}`).toString(),
        expiresAt: new Date(now() + ttl * 1000).toISOString(),
      };
    },

    async delete(prefix: ObjectKey): Promise<void> {
      if (!DELETE_PREFIX.test(prefix)) throw new Error(`delete takes a release folder ending in /, not ${prefix}`);
      const bucket = bucketOf(prefix);
      const names = await listAll(bucket, prefix.slice(0, -1));
      for (let i = 0; i < names.length; i += 1000) {
        await call(
          `${api}/object/${bucket}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prefixes: names.slice(i, i + 1000) }),
          },
          "deleting objects",
        );
      }
      const left = await listAll(bucket, prefix.slice(0, -1));
      if (left.length > 0) throw new StorageError(500, `${left.length} objects under ${prefix} were not deleted`);
    },
  };

  /** Every object name under a folder, walking subfolders. */
  async function listAll(bucket: string, folder: string): Promise<string[]> {
    const found: string[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const response = await call(
        `${api}/object/list/${bucket}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prefix: folder, limit: pageSize, offset, sortBy: { column: "name", order: "asc" } }),
        },
        "listing objects",
      );
      if (!response.ok) return found;
      const items = (await response.json()) as { name: string; id: string | null }[];
      for (const item of items) {
        const path = `${folder}/${item.name}`;
        // Supabase lists a subfolder as an entry with no id.
        if (item.id === null) found.push(...(await listAll(bucket, path)));
        else found.push(path);
      }
      if (items.length < pageSize) return found;
    }
  }
}

/** For tear-down only: every object in a bucket, then the bucket. */
export async function emptyAndDeleteBucket(
  options: Pick<SupabaseStorageOptions, "supabaseUrl" | "serviceKey" | "fetch">,
  bucket: string,
): Promise<void> {
  const api = `${options.supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
  const doFetch = options.fetch ?? fetch;
  const headers = { ...serviceHeaders(options.serviceKey), "content-type": "application/json" };
  const empty = await doFetch(`${api}/bucket/${bucket}/empty`, { method: "POST", headers, body: "{}" });
  if (empty.status === 404) return;
  if (!empty.ok) throw new StorageError(empty.status, `emptying ${bucket} failed`);
  const gone = await doFetch(`${api}/bucket/${bucket}`, { method: "DELETE", headers });
  if (!gone.ok && gone.status !== 404) throw new StorageError(gone.status, `deleting ${bucket} failed`);
}

// startUpload, startCoverUpload, getUpload, signUploadParts and confirmUpload.
import type { Queryable, ReleaseState, StorageUpload } from "../platform/index.ts";
import { allow, operation, whoIsCalling, type Context, type Settings, type Who } from "./context.ts";
import { badRequest, conflict, json, notFound, unprocessable } from "./http.ts";
import { imageSize } from "./image.ts";
import { ownRelease } from "./releases.ts";
import {
  arrayField,
  enumField,
  integerField,
  objectField,
  pathUuid,
  readJsonObject,
  stringField,
} from "./validate.ts";

const MASTER_MAX_BYTES = 5368709120;
const COVER_MAX_BYTES = 20971520;
const SHA256 = /^[0-9a-f]{64}$/;
// What the cover check reads. A JPEG's size sits after its EXIF block, which can be large.
const COVER_HEAD_BYTES = 1024 * 1024;

const MASTER_ALLOWED: readonly ReleaseState[] = ["draft", "uploading", "needs_changes", "failed"];
const COVER_ALLOWED: readonly ReleaseState[] = ["draft", "uploading", "processing", "awaiting_splits", "needs_changes"];

interface UploadRow {
  id: string;
  release_id: string;
  track_id: string | null;
  kind: "master" | "cover";
  method: "tus" | "s3_multipart";
  provider_upload_id: string;
  object_key: string;
  format: string;
  size_bytes: string;
  state: "open" | "confirmed" | "replaced" | "cancelled";
  owner_id: string;
  release_state: ReleaseState;
}

/** The caller's own upload. Someone else's, or none, is 404. */
async function ownUpload(db: Queryable, who: Who, uploadId: string): Promise<UploadRow> {
  const rows = await db.query<UploadRow>(
    `select u.id::text as id, u.release_id::text as release_id, u.track_id::text as track_id, u.kind, u.method,
            u.provider_upload_id, u.object_key, u.format, u.size_bytes::text as size_bytes, u.state,
            r.owner_id::text as owner_id, r.state as release_state
       from public.api_uploads u join public.api_releases r on r.id = u.release_id
      where u.id = $1::uuid`,
    [uploadId],
  );
  const upload = rows[0];
  if (!upload || upload.owner_id !== who.userId) throw notFound("No such upload.");
  return upload;
}

/** The contract's UploadSession: what storage said, plus the ids the core adds. */
function sessionView(
  upload: { id: string; kind: "master" | "cover"; track_id: string | null; object_key: string; size_bytes: number },
  stored: StorageUpload,
) {
  const common: Record<string, unknown> = {
    method: stored.method,
    uploadId: upload.id,
    kind: upload.kind,
  };
  if (upload.kind === "master" && upload.track_id) common.trackId = upload.track_id;
  common.objectKey = upload.object_key;
  common.sizeBytes = upload.size_bytes;
  if (stored.method === "tus") {
    const view: Record<string, unknown> = { ...common, endpoint: stored.endpoint };
    if (stored.headers) view.headers = stored.headers;
    if (stored.metadata) view.metadata = stored.metadata;
    view.offset = stored.offset;
    view.expiresAt = stored.expiresAt;
    return view;
  }
  return {
    ...common,
    partSize: stored.partSize,
    partCount: stored.partCount,
    parts: stored.parts,
    completedParts: stored.completedParts,
    expiresAt: stored.expiresAt,
  };
}

async function start(
  ctx: Context,
  kind: "master" | "cover",
  releaseId: string,
  trackId: string | null,
  format: string,
  sizeBytes: number,
): Promise<Response> {
  const db = ctx.modules.database;
  const who = await whoIsCalling(ctx);
  allow(who, ["artist"]);
  // Checked before storage, so a refused call opens no upload. Session B checks again when it
  // records the upload, with the release locked.
  const release = await ownRelease(db, who, releaseId);
  const allowed = kind === "master" ? MASTER_ALLOWED : COVER_ALLOWED;
  if (!allowed.includes(release.state)) {
    throw conflict("wrong_state", `No ${kind === "master" ? "master" : "cover"} upload while ${release.state}.`);
  }
  const [{ key }] = await db.query<{ key: string }>(
    "select public.api_upload_key($1::uuid, $2::uuid, $3::text) as key",
    [releaseId, trackId, kind],
  );
  const stored = await ctx.modules.storage.startUpload({
    key,
    format: format as "wav" | "aiff" | "flac" | "jpeg" | "png",
    sizeBytes,
  });
  const [recorded] = await db.query<{ upload_id: string; object_key: string }>(
    `select s.upload_id::text as upload_id, s.object_key
       from public.api_start_upload($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::bigint, $8::timestamptz) s`,
    [releaseId, trackId, kind, stored.method, stored.providerUploadId, format, sizeBytes, stored.expiresAt],
  );
  // Only now, with the new upload recorded, end the one it replaced. A failure here does not
  // fail the start: the bucket's lifecycle rule ends a left-over upload within a day.
  try {
    await ctx.modules.storage.abortOtherUploads(key, stored.providerUploadId);
  } catch (error) {
    ctx.settings.log(`upload ${recorded.upload_id}: ending the uploads it replaced failed: ${(error as Error)?.message ?? String(error)}`);
  }
  return json(
    201,
    sessionView({ id: recorded.upload_id, kind, track_id: trackId, object_key: recorded.object_key, size_bytes: sizeBytes }, stored),
    ctx.requestId,
  );
}

export function uploadOperations(s: Settings) {
  const startUpload = operation("startUpload", "POST /v1/releases/{releaseId}/tracks/{trackId}/uploads", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const trackId = pathUuid(ctx.params.trackId, "trackId");
    const body = await readJsonObject(ctx.request);
    const format = enumField(body.format, "format", ["wav", "aiff", "flac"] as const);
    const sizeBytes = integerField(body.sizeBytes, "sizeBytes", 1, MASTER_MAX_BYTES);
    return start(ctx, "master", releaseId, trackId, format, sizeBytes);
  });

  const startCoverUpload = operation("startCoverUpload", "POST /v1/releases/{releaseId}/cover/uploads", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const body = await readJsonObject(ctx.request);
    const format = enumField(body.format, "format", ["jpeg", "png"] as const);
    const sizeBytes = integerField(body.sizeBytes, "sizeBytes", 1, COVER_MAX_BYTES);
    return start(ctx, "cover", releaseId, null, format, sizeBytes);
  });

  const getUpload = operation("getUpload", "GET /v1/uploads/{uploadId}", s, async (ctx) => {
    const uploadId = pathUuid(ctx.params.uploadId, "uploadId");
    const who = await whoIsCalling(ctx);
    allow(who, ["artist"]);
    const upload = await ownUpload(ctx.modules.database, who, uploadId);
    // Before storage: on Supabase getUpload signs a fresh upload token, which a closed upload
    // (confirmed, replaced, or cancelled by a takedown) must not get.
    if (upload.state !== "open") throw conflict("upload_closed", `This upload is ${upload.state}.`);
    // Also before storage: an upload the release's state no longer allows gets no token
    // either (finding H2), for example a cover left open after submit, review or publish.
    const allowed = upload.kind === "master" ? MASTER_ALLOWED : COVER_ALLOWED;
    if (!allowed.includes(upload.release_state)) {
      throw conflict("upload_closed", `No ${upload.kind} upload while the release is ${upload.release_state}.`);
    }
    const stored = await ctx.modules.storage.getUpload(upload.object_key, upload.provider_upload_id);
    return json(200, sessionView({ ...upload, size_bytes: Number(upload.size_bytes) }, stored), ctx.requestId);
  });

  const signUploadParts = operation("signUploadParts", "POST /v1/uploads/{uploadId}/parts", s, async (ctx) => {
    const uploadId = pathUuid(ctx.params.uploadId, "uploadId");
    const body = await readJsonObject(ctx.request);
    const partNumbers = arrayField(body.partNumbers, "partNumbers", 1, 1000).map((n, i) =>
      integerField(n, `partNumbers[${i}]`, 1, 10000),
    );
    const who = await whoIsCalling(ctx);
    allow(who, ["artist"]);
    const upload = await ownUpload(ctx.modules.database, who, uploadId);
    if (upload.method !== "s3_multipart") {
      throw conflict("wrong_method", "This upload uses tus; it has no parts to sign.");
    }
    if (upload.state !== "open") throw conflict("upload_closed", `This upload is ${upload.state}.`);
    // Storage refuses a part number past the upload's last part; say so as the contract's 400.
    const progress = await ctx.modules.storage.getUpload(upload.object_key, upload.provider_upload_id);
    if (progress.method === "s3_multipart") {
      const tooHigh = partNumbers.find((n) => n > progress.partCount);
      if (tooHigh !== undefined) {
        throw badRequest(`This upload has parts 1 to ${progress.partCount}, not ${tooHigh}.`, { field: "partNumbers" });
      }
    }
    const parts = await ctx.modules.storage.signParts(upload.object_key, upload.provider_upload_id, [...new Set(partNumbers)]);
    return json(200, { parts }, ctx.requestId);
  });

  const confirmUpload = operation("confirmUpload", "POST /v1/uploads/{uploadId}/confirm", s, async (ctx) => {
    const uploadId = pathUuid(ctx.params.uploadId, "uploadId");
    const body = await readJsonObject(ctx.request);
    if (typeof body.sha256 !== "string" || !SHA256.test(body.sha256)) {
      throw badRequest("sha256 must be 64 lowercase hex characters.", { field: "sha256" });
    }
    const sha256 = body.sha256;
    const crc64nvme = body.crc64nvme === undefined ? undefined : stringField(body.crc64nvme, "crc64nvme", 1, 64);
    const parts =
      body.parts === undefined
        ? undefined
        : arrayField(body.parts, "parts", 0, 10000).map((p, i) => {
            const o = objectField(p, `parts[${i}]`);
            return {
              partNumber: integerField(o.partNumber, `parts[${i}].partNumber`, 1, 10000),
              etag: stringField(o.etag, `parts[${i}].etag`, 1, 1024),
            };
          });

    const db = ctx.modules.database;
    const who = await whoIsCalling(ctx);
    allow(who, ["artist"]);
    const upload = await ownUpload(db, who, uploadId);
    if (upload.state !== "open") throw conflict("upload_closed", `This upload is ${upload.state}.`);
    // Decided by K Marcus: an s3_multipart confirm needs both, as the contract's 400, before storage.
    if (upload.method === "s3_multipart" && (!crc64nvme || !parts || parts.length === 0)) {
      throw badRequest("An s3_multipart upload is confirmed with crc64nvme and parts.", {
        field: !crc64nvme ? "crc64nvme" : "parts",
      });
    }

    const checked = await ctx.modules.storage.confirmUpload({
      key: upload.object_key,
      providerUploadId: upload.provider_upload_id,
      sha256,
      ...(upload.method === "s3_multipart" ? { crc64nvme, parts } : {}),
    });
    if (!checked.ok) {
      // The upload stays open, so the client can send the rest or try again.
      throw checked.reason === "incomplete"
        ? unprocessable("incomplete", "The file is not all there yet. Finish the upload, then confirm again.")
        : unprocessable("checksum_mismatch", "The stored file does not match what was sent. Upload it again.");
    }

    let width: number | null = null;
    let height: number | null = null;
    if (upload.kind === "cover") {
      const head = await ctx.modules.storage.readHead(upload.object_key, COVER_HEAD_BYTES);
      const size = imageSize(head);
      if (!size) throw unprocessable("unreadable_image", "The cover could not be read as a PNG or JPEG.");
      if (size.format !== upload.format) {
        throw unprocessable("unreadable_image", `The cover was started as ${upload.format} but the file is ${size.format}.`);
      }
      if (size.width !== size.height) {
        throw unprocessable("not_square", `The cover must be square; this one is ${size.width} by ${size.height} pixels.`);
      }
      if (size.width < ctx.settings.minCoverPixels) {
        throw unprocessable("too_small", `The cover must be at least ${ctx.settings.minCoverPixels} pixels on each side.`);
      }
      if (size.width > ctx.settings.maxCoverPixels) {
        throw unprocessable(
          "too_large_image",
          `The cover must be at most ${ctx.settings.maxCoverPixels} pixels on each side; this one is ${size.width}.`,
        );
      }
      width = size.width;
      height = size.height;
    }

    const [confirmed] = await db.query<{
      kind: "master" | "cover";
      track_id: string | null;
      release_state: ReleaseState;
      start_processing: boolean;
    }>(
      `select c.kind, c.track_id::text as track_id, c.release_state, c.start_processing
         from public.api_confirm_upload($1::uuid, $2::text, $3::text, $4::integer, $5::integer) c`,
      [uploadId, sha256, upload.method === "s3_multipart" ? (crc64nvme ?? null) : null, width, height],
    );

    if (confirmed.start_processing) {
      // After the commit: the job row needs the release to be processing. If this fails the
      // release stays processing with no job; makeRequeueStuckReleases picks it up later.
      try {
        await ctx.modules.jobs.enqueue({ kind: "process_release", releaseId: upload.release_id });
      } catch (error) {
        ctx.settings.log(
          `release ${upload.release_id} is processing but its job was not queued: ${(error as Error)?.message ?? String(error)}`,
        );
      }
    }

    const view: Record<string, unknown> = { uploadId, kind: confirmed.kind };
    if (confirmed.kind === "master" && confirmed.track_id) view.trackId = confirmed.track_id;
    view.releaseState = confirmed.release_state;
    return json(200, view, ctx.requestId);
  });

  return { startUpload, startCoverUpload, getUpload, signUploadParts, confirmUpload };
}

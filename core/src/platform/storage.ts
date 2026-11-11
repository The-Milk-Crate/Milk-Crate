import type { AudioFormat, ObjectKey } from "./types";
import type { ReadGrantBody } from "./playback";

export interface StartUploadInput {
  key: ObjectKey;
  /** Audio for masters, `jpeg` or `png` for cover art. */
  format: AudioFormat | "jpeg" | "png";
  sizeBytes: number;
}

export interface SignedPart {
  partNumber: number;
  url: string;
  headers?: Record<string, string>;
  expiresAt: string;
}

/** Tagged union by `method`. Mirrors UploadSession, without the ids the core adds. */
export type StorageUpload =
  | {
      method: "tus";
      providerUploadId: string;
      endpoint: string;
      headers?: Record<string, string>;
      metadata?: Record<string, string>;
      offset: number;
      expiresAt: string;
    }
  | {
      method: "s3_multipart";
      providerUploadId: string;
      partSize: number;
      partCount: number;
      parts: SignedPart[];
      completedParts: { partNumber: number; sizeBytes: number }[];
      expiresAt: string;
    };

export interface ConfirmUploadInput {
  key: ObjectKey;
  providerUploadId: string;
  sha256: string;
  /** S3 only. */
  crc64nvme?: string;
  /** S3 only. */
  parts?: { partNumber: number; etag: string }[];
}

export type ConfirmUploadResult =
  | { ok: true }
  | { ok: false; reason: "checksum_mismatch" | "incomplete" };

export interface SignReadInput {
  key: ObjectKey;
  /** The listener the grant is for. */
  userId: string;
}

/** Start an upload, confirm it, sign a read, delete. */
export interface ObjectStorage {
  startUpload(input: StartUploadInput): Promise<StorageUpload>;
  /** Progress of an upload that was interrupted. */
  getUpload(key: ObjectKey, providerUploadId: string): Promise<StorageUpload>;
  /** More presigned parts (s3_multipart only). */
  signParts(key: ObjectKey, providerUploadId: string, partNumbers: number[]): Promise<SignedPart[]>;
  confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResult>;
  /** The core adds the track or release id. */
  signRead(input: SignReadInput): Promise<ReadGrantBody>;
  /** Delete every object whose key starts with the prefix. */
  delete(prefix: ObjectKey): Promise<void>;
}

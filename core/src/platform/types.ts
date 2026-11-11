/** Shared types for the API core. Mirrors api/openapi.yaml. Types only. */

export type AccountType =
  | "end_user"
  | "artist"
  | "third_party"
  | "administrator"
  | "internal"
  | "internal_accounting";

export type ReleaseState =
  | "draft"
  | "uploading"
  | "processing"
  | "awaiting_splits"
  | "awaiting_review"
  | "needs_changes"
  | "scheduled"
  | "live"
  | "failed"
  | "taken_down";

export type AudioFormat = "wav" | "aiff" | "flac";

/** The one error shape. */
export interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

/**
 * A handler uses web-standard Request/Response and takes its modules as an argument,
 * so the same handler runs on Edge Functions (Deno) and Lambda (Node).
 */
export type Handler<Deps> = (request: Request, deps: Deps) => Promise<Response>;

/** The key of a stored object, such as `masters/{artist}/{release}/{track}/original`. Never a URL. */
export type ObjectKey = string;

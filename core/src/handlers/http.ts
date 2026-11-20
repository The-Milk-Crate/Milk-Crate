import type { ApiError } from "../platform/index.ts";

/**
 * An error a handler returns on purpose, in the contract's one `Error` shape. Throw it from
 * anywhere in a handler; the operation wrapper turns it into the response.
 */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  constructor(
    status: number,
    code: string,
    message: string,
    extra: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.headers = extra.headers;
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiFailure(400, "bad_request", message, { details });
export const unauthorized = () => new ApiFailure(401, "unauthorized", "Sign in first.");
export const forbidden = (message = "This account may not do this.") => new ApiFailure(403, "forbidden", message);
export const notFound = (message = "Not found.") => new ApiFailure(404, "not_found", message);
export const conflict = (code: string, message: string) => new ApiFailure(409, code, message);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiFailure(422, code, message, { details });
export const tooMany = (code: string, message: string, retryAfterSeconds: number) =>
  new ApiFailure(429, code, message, { headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) } });

export function json(status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId, ...headers },
  });
}

export function noContent(requestId: string): Response {
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
}

export function errorResponse(failure: ApiFailure, requestId: string): Response {
  const body: ApiError = { code: failure.code, message: failure.message, requestId };
  if (failure.details) body.details = failure.details;
  return json(failure.status, body, requestId, failure.headers);
}

const SQLSTATE_TO_HTTP: Record<string, number> = { MC403: 403, MC404: 404, MC409: 409, MC422: 422 };

function plainWords(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "This request cannot be done.";
  const first = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/**
 * Turns an error from a module into the contract's error, or returns null when it is not one we
 * map (the caller then answers 500).
 *
 * - `Database` (both deployments): `code` is the SQLSTATE. Session B's `MC403`, `MC404`, `MC409`
 *   and `MC422` keep their status; the code word at the start of the message becomes `code`.
 *   A plain constraint error (`23xxx`) is a request the handler should have refused: 422.
 * - `ObjectStorage` (both deployments): `status` is HTTP-like. 404 is no such object; 413 is a
 *   file over this deployment's size limit, which the contract has no 413 for, so it is 422
 *   `too_large`; 400 is a request storage refused as malformed.
 */
export function mapModuleError(error: unknown): ApiFailure | null {
  if (error instanceof ApiFailure) return error;
  const e = error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return null;
  const message = typeof e.message === "string" ? e.message : "";

  if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
    const status = SQLSTATE_TO_HTTP[e.code];
    if (status) {
      const match = /^([a-z][a-z0-9_]*):\s*([\s\S]*)$/.exec(message.split("\n")[0]);
      const code = match ? match[1] : status === 404 ? "not_found" : status === 403 ? "forbidden" : status === 409 ? "wrong_state" : "unprocessable";
      return new ApiFailure(status, code, plainWords(match ? match[2] : message));
    }
    if (e.code.startsWith("23")) {
      return new ApiFailure(422, "unprocessable", "The request breaks a rule of the release data.");
    }
    return null;
  }

  if (typeof e.status === "number") {
    if (e.status === 404) return notFound("The file is not there.");
    if (e.status === 413) {
      return new ApiFailure(422, "too_large", plainWords(message || "The file is larger than this deployment takes"));
    }
    if (e.status === 400) return badRequest(plainWords(message || "Storage refused the request"));
  }
  return null;
}

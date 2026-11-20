// One router for every operation, so an entry point can serve them all from one function.
import type { Handler, Modules } from "../platform/index.ts";
import { matchPath, settings, type CoreOptions, type Operation } from "./context.ts";
import { errorResponse, ApiFailure } from "./http.ts";
import { playbackOperations } from "./playback.ts";
import { releaseOperations } from "./releases.ts";
import { rightsOperations } from "./rights.ts";
import { uploadOperations } from "./uploads.ts";

export type OperationId =
  | "createRelease"
  | "getRelease"
  | "getPublicRelease"
  | "startUpload"
  | "getUpload"
  | "signUploadParts"
  | "confirmUpload"
  | "updateRelease"
  | "listReleases"
  | "startCoverUpload"
  | "getCover"
  | "putRights"
  | "getInvitation"
  | "respondToSplit"
  | "resendInvitation"
  | "submitRelease"
  | "reviewRelease"
  | "publishRelease"
  | "takedownRelease"
  | "getPlayback"
  | "recordPlays";

/** Every operation in the contract, with its route and handler. */
export function makeOperations(options: CoreOptions = {}): Record<OperationId, Operation> {
  const s = settings(options);
  return {
    ...releaseOperations(s),
    ...uploadOperations(s),
    ...rightsOperations(s),
    ...playbackOperations(s),
  };
}

/**
 * Maps method and path to the operation's handler. The path is the contract's (`/v1/...`):
 * session E's adapter cuts the function name off before the handler sees it. No match is the
 * contract's 404.
 */
export function makeRouter(options: CoreOptions = {}): Handler<Modules> {
  const all = Object.values(makeOperations(options));
  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
  return async (request, modules) => {
    const pathname = new URL(request.url).pathname;
    const op = all.find((o) => o.method === request.method && matchPath(o.path, pathname));
    if (op) return op.handler(request, modules);
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || newRequestId();
    return errorResponse(new ApiFailure(404, "not_found", "No such operation."), requestId);
  };
}

// Everything a deployment needs from the shared core, from one place.
//
//   import { createRelease, router, makeApplyJobResult } from "<repo>/core/src/handlers/index.ts";
//
// Each handler is a `Handler<Modules>`: (request: Request, modules: Modules) => Promise<Response>,
// with the contract's path (`/v1/...`). `operations` lists every operation with its route, as
// "METHOD /v1/path/{param}", for session E's `serveOperation` and session F's routes.json.
import { makeOperations, makeRouter } from "./router.ts";

export {
  makeApplyJobResult,
  makeRequeueStuckReleases,
  type ApplyJobResult,
  type RequeueOptions,
  type RequeueResult,
} from "./jobs.ts";
export { makeOperations, makeRouter, type OperationId } from "./router.ts";
export type { CoreOptions, Operation } from "./context.ts";
export { imageSize, type ImageSize } from "./image.ts";
export { hashInviteCode } from "./rights.ts";

/** The operations with the default clock and random source. */
export const operations = makeOperations();
/** One handler for every operation. */
export const router = makeRouter();

export const createRelease = operations.createRelease.handler;
export const getRelease = operations.getRelease.handler;
export const getPublicRelease = operations.getPublicRelease.handler;
export const startUpload = operations.startUpload.handler;
export const getUpload = operations.getUpload.handler;
export const signUploadParts = operations.signUploadParts.handler;
export const confirmUpload = operations.confirmUpload.handler;
export const updateRelease = operations.updateRelease.handler;
export const listReleases = operations.listReleases.handler;
export const startCoverUpload = operations.startCoverUpload.handler;
export const getCover = operations.getCover.handler;
export const putRights = operations.putRights.handler;
export const getInvitation = operations.getInvitation.handler;
export const respondToSplit = operations.respondToSplit.handler;
export const resendInvitation = operations.resendInvitation.handler;
export const submitRelease = operations.submitRelease.handler;
export const reviewRelease = operations.reviewRelease.handler;
export const publishRelease = operations.publishRelease.handler;
export const takedownRelease = operations.takedownRelease.handler;
export const getPlayback = operations.getPlayback.handler;
export const recordPlays = operations.recordPlays.handler;

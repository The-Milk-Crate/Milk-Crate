// Session H's shared processing step, for both workers (Fly Machines and Fargate). Each
// platform's scripts/copy-core.sh copies this folder (worker/src/) into its build folder as
// _worker/, and its worker/main.ts passes makeProcessRelease(...) to its skeleton.
export { makeProcessRelease, streamFolder, type ProcessDeps } from "./process.ts";
export { STREAM_CONTENT_TYPE, STREAM_FILE, type Tools } from "./media.ts";
export type { JobResult, JobToRun, WorkerDatabase, WorkerStorage } from "./types.ts";

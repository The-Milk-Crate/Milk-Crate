import { serveOperation } from "../src/lambda.ts";
import { startCoverUpload } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/cover/uploads", startCoverUpload);

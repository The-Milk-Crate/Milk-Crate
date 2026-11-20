import { serveOperation } from "../src/lambda.ts";
import { startUpload } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/tracks/{trackId}/uploads", startUpload);

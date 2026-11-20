import { serveOperation } from "../src/lambda.ts";
import { submitRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/submit", submitRelease);

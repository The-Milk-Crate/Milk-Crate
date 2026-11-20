import { serveOperation } from "../src/lambda.ts";
import { getRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/releases/{releaseId}", getRelease);

import { serveOperation } from "../src/lambda.ts";
import { getCover } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/releases/{releaseId}/cover", getCover);

import { serveOperation } from "../src/lambda.ts";
import { getPublicRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/public/releases/{releaseId}", getPublicRelease);

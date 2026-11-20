import { serveOperation } from "../src/lambda.ts";
import { putRights } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("PUT /v1/releases/{releaseId}/rights", putRights);

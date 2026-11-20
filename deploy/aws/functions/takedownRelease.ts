import { serveOperation } from "../src/lambda.ts";
import { takedownRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/takedown", takedownRelease);

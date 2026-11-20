import { serveOperation } from "../src/lambda.ts";
import { reviewRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/review", reviewRelease);

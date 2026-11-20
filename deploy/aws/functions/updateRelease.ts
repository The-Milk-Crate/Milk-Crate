import { serveOperation } from "../src/lambda.ts";
import { updateRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("PATCH /v1/releases/{releaseId}", updateRelease);

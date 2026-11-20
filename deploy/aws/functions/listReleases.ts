import { serveOperation } from "../src/lambda.ts";
import { listReleases } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/releases", listReleases);

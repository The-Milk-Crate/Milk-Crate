import { serveOperation } from "../src/lambda.ts";
import { getUpload } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/uploads/{uploadId}", getUpload);

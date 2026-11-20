import { serveOperation } from "../src/lambda.ts";
import { confirmUpload } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/uploads/{uploadId}/confirm", confirmUpload);

import { serveOperation } from "../src/lambda.ts";
import { createRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases", createRelease);

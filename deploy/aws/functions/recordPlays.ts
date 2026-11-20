import { serveOperation } from "../src/lambda.ts";
import { recordPlays } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/plays", recordPlays);

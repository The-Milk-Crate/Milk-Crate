import { serveOperation } from "../src/lambda.ts";
import { respondToSplit } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/rights/parties/{partyId}/respond", respondToSplit);

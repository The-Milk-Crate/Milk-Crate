import { serveOperation } from "../src/lambda.ts";
import { resendInvitation } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("POST /v1/releases/{releaseId}/rights/parties/{partyId}/resend", resendInvitation);

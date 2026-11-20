import { serveOperation } from "../src/lambda.ts";
import { getPlayback } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/tracks/{trackId}/playback", getPlayback);

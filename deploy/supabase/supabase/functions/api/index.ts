// The one Edge Function for the API (decided by K Marcus): session G's router serves every
// operation, so the app has one address, .../functions/v1/api/v1/... The handlers come from
// _core/, the copy of core/src/ that scripts/copy-core.sh makes before a deploy.
import { serveOperation } from "../../../src/edge.ts";
import { router } from "../_core/handlers/index.ts";

serveOperation("*", router);

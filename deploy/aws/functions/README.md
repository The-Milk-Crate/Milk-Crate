# Lambda entry points (one per operation)

One file per operation in session G's handlers (`core/src/handlers/index.ts`), and one entry
per operation in `routes.json`, which the CDK stack reads to make one Lambda and one API Gateway
route per operation. All 21 are here. Each file only wires the shared handler:

```ts
// functions/getRelease.ts
import { serveOperation } from "../src/lambda.ts";
import { getRelease } from "../../../core/src/handlers/index.ts";
export const handler = serveOperation("GET /v1/releases/{releaseId}", getRelease);
```

```json
{ "operationId": "getRelease", "route": "GET /v1/releases/{releaseId}", "entry": "getRelease.ts" }
```

esbuild bundles `core/src/` straight from the repository. `test/stack.test.ts` checks that the
files and `routes.json` match `operations` in the core exactly, so a new operation in the core
fails the test until it has an entry here.

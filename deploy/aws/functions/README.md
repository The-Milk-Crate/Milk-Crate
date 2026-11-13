# Lambda entry points (one per operation)

None yet: they wait on session G's handlers and the path G states for them.

Each operation gets a two-line file here, and an entry in `routes.json`, which the CDK stack
reads to make one Lambda and one API Gateway route per operation:

```ts
// functions/getRelease.ts
import { serveOperation } from "../src/lambda.ts";
import { getRelease } from "<session G's path>";
export const handler = serveOperation("GET /v1/releases/{releaseId}", getRelease);
```

```json
[{ "operationId": "getRelease", "route": "GET /v1/releases/{releaseId}", "entry": "getRelease.ts" }]
```

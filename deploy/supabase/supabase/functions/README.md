# Edge Functions

One entry point per operation, each a folder here with an `index.ts` that only wires a shared
handler from session G to `serveOperation` (`deploy/supabase/src/edge.ts`):

```ts
import { serveOperation } from "../../../src/edge.ts";
import { createRelease } from "<session G's path>";
serveOperation("POST /v1/releases", createRelease);
```

None exist yet: they wait until session G states where its handlers live (an open point).
`scripts/stand-up.sh` deploys every folder here that has an `index.ts` and does not start
with `_`, with `verify_jwt` off, because `Identity` checks the token itself (the gateway's
check does not know the newer signing keys, and a missing token must still get the
contract's 401).

`deno.json` maps the two packages to npm. `sloppy-imports` lets Deno follow `core/`'s
imports, which have no file extensions (they are type-only and erased at run time).

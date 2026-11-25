# Edge Functions

One Edge Function, `api`, serves every operation through session G's router (decided by K
Marcus): the app has one address, `https://<ref>.supabase.co/functions/v1/api/v1/...`. The
adapter (`src/functions.ts`) cuts the path to `/v1/...` before the router sees it.

```ts
// api/index.ts
import { serveOperation } from "../../../src/edge.ts";
import { router } from "../_core/handlers/index.ts";
serveOperation("*", router);
```

`_core/` is a copy of `core/src/`, made by `scripts/copy-core.sh` (stand-up.sh and test/run.sh
run it; it is not committed). Supabase deploys shared code from a folder starting with `_`, and
its bundler may not follow an import out of this project to `core/`. Run the script before
`npx tsc` or `supabase functions serve`.

`scripts/stand-up.sh` deploys every folder here that has an `index.ts` and does not start
with `_`, with `verify_jwt` off, because `Identity` checks the token itself (the gateway's
check does not know the newer signing keys, and a missing token must still get the
contract's 401).

`deno.json` maps the two packages to npm, and `deno.lock` next to it pins their hashes (how to
make it again: `deploy/supabase/README.md`, "Edge Function dependencies"). `sloppy-imports` lets Deno follow `core/`'s
platform imports, which have no file extensions (they are type-only and erased at run time).

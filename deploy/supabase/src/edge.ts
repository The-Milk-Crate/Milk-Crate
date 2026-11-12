import type { Handler, Modules } from "./core.ts";
import { edgeFunctions } from "./functions.ts";
import { createSupabaseModules } from "./modules.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

let modules: Modules | undefined;

/**
 * The whole of an Edge Function entry point: build the modules once per instance from the
 * function's secrets, and serve one shared handler (session G) on its route.
 *
 *   import { serveOperation } from "../../../src/edge.ts";
 *   import { <handler> } from "<session G's path>";
 *   serveOperation("<METHOD> /v1/<path>", <handler>);
 */
export function serveOperation(route: string, handler: Handler<Modules>): void {
  modules ??= createSupabaseModules((name) => Deno.env.get(name), { poolSize: 3 });
  edgeFunctions({ serve: (h) => Deno.serve(h) }).handle(route, handler, modules);
}

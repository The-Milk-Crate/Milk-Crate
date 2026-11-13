import type { Handler, Modules } from "./core.ts";
import { lambdaFunctions, type LambdaHandler } from "./functions.ts";
import { createAwsModules } from "./modules.ts";

let modules: Modules | undefined;

/**
 * The whole of a Lambda entry point: build the modules once per instance from the function's
 * environment, and serve one shared handler (session G) on its route.
 *
 *   import { serveOperation } from "../src/lambda.ts";
 *   import { <handler> } from "<session G's path>";
 *   export const handler = serveOperation("<METHOD> /v1/<path>", <handler>);
 */
export function serveOperation(route: string, handler: Handler<Modules>): LambdaHandler {
  modules ??= createAwsModules((name) => process.env[name]);
  const functions = lambdaFunctions();
  functions.handle(route, handler, modules);
  return functions.lambdaHandler;
}

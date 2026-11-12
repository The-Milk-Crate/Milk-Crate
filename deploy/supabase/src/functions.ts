import type { Handler, ServerFunctions } from "./core.ts";

/** Deno.serve, or a stand-in in tests. */
export type Serve = (handler: (request: Request) => Response | Promise<Response>) => unknown;

interface Route {
  method: string;
  pattern: RegExp | null;
  run: (request: Request) => Promise<Response>;
}

function json(status: number, code: string, message: string, requestId: string): Response {
  return new Response(JSON.stringify({ code, message, requestId }), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

/** "GET /v1/releases/{releaseId}" → method and a path pattern. "*" takes every request. */
function parseRoute(route: string): { method: string; pattern: RegExp | null } {
  if (route.trim() === "*") return { method: "*", pattern: null };
  const match = /^([A-Z]+) (\/[^\s]*)$/.exec(route.trim());
  if (!match) throw new Error(`a route is "METHOD /path" or "*", not ${route}`);
  const path = match[2]
    .split("/")
    .map((part) => (/^\{[A-Za-z]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { method: match[1], pattern: new RegExp(`^${path}/?$`) };
}

/**
 * `ServerFunctions` on Supabase Edge Functions. Each `handle` registers a handler; the first
 * call starts `Deno.serve` once all handlers in that tick are registered.
 *
 * The request reaches the function as /<function-name>/v1/... (or /functions/v1/<name>/v1/...).
 * The handler gets the same request with the path cut to /v1/..., so the shared handlers see
 * the contract's paths on both deployments. Anything not matched is a 404 in the contract's
 * error shape, and a thrown error is a 500 with no details.
 */
export function edgeFunctions(options: { serve: Serve; log?: (message: string) => void }): ServerFunctions {
  const routes: Route[] = [];
  const log = options.log ?? ((m: string) => console.error(m));
  let started = false;

  async function dispatch(request: Request): Promise<Response> {
    const requestId = request.headers.get("sb-request-id") ?? request.headers.get("x-request-id") ?? crypto.randomUUID();
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/functions\/v1(?=\/)/, "");
    // After the function's own name, the contract's path starts at /v1/.
    const at = url.pathname.indexOf("/v1/");
    if (at < 0) return json(404, "not_found", "No such operation.", requestId);
    url.pathname = url.pathname.slice(at);
    const route = routes.find((r) => (r.method === "*" || r.method === request.method) && (!r.pattern || r.pattern.test(url.pathname)));
    if (!route) return json(404, "not_found", "No such operation.", requestId);
    const inner = new Request(url, request);
    try {
      return await route.run(inner);
    } catch (error) {
      log(`request ${requestId} failed: ${(error as Error)?.stack ?? String(error)}`);
      return json(500, "internal", "Something went wrong. Try again later.", requestId);
    }
  }

  return {
    handle<Deps>(route: string, handler: Handler<Deps>, deps: Deps): void {
      const { method, pattern } = parseRoute(route);
      routes.push({ method, pattern, run: (request) => handler(request, deps) });
      if (!started) {
        started = true;
        queueMicrotask(() => options.serve(dispatch));
      }
    },
  };
}

import type { Handler, ServerFunctions } from "./core.ts";

/** API Gateway HTTP API event, payload format 2.0 (the parts the adapter reads). */
export interface HttpApiEvent {
  version?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { domainName?: string; requestId?: string; http: { method: string } };
}

export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

export type LambdaHandler = (event: HttpApiEvent) => Promise<HttpApiResult>;

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

/** "GET /v1/releases/{releaseId}" → method and a path pattern. "*" takes every request. Same as session E. */
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

const TEXT = /^(text\/|application\/(json|problem\+json|xml|x-www-form-urlencoded)|[^;]*\+json)/i;

/** The API Gateway event as a web-standard Request. */
export function toRequest(event: HttpApiEvent): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const host = event.requestContext.domainName ?? headers.get("host") ?? "localhost";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const method = event.requestContext.http.method.toUpperCase();
  const hasBody = event.body !== undefined && event.body !== null && method !== "GET" && method !== "HEAD";
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, "base64") : event.body!) : undefined;
  return new Request(`https://${host}${event.rawPath}${query}`, { method, headers, body });
}

/** A web-standard Response as the API Gateway result. Text stays text; anything else is base64. */
export async function fromResponse(response: Response): Promise<HttpApiResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  const type = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const isText = bytes.length === 0 || TEXT.test(type);
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64"),
    isBase64Encoded: !isText,
  };
}

export interface LambdaFunctions extends ServerFunctions {
  /** The Lambda handler to export from the entry point. */
  lambdaHandler: LambdaHandler;
}

/**
 * `ServerFunctions` on Lambda behind an API Gateway HTTP API (payload 2.0). `handle` registers
 * a shared handler on a route; `lambdaHandler` turns each event into a `Request`, runs the
 * matching handler with its modules and turns the `Response` back.
 *
 * The handler sees the contract's path (/v1/...), also when the API has a named stage. No match
 * is a 404 in the contract's error shape; a thrown error is a 500 with no details, logged with
 * the request id. The same behaviour as session E's Edge Function adapter.
 */
export function lambdaFunctions(options: { log?: (message: string) => void } = {}): LambdaFunctions {
  const routes: Route[] = [];
  const log = options.log ?? ((m: string) => console.error(m));

  async function dispatch(request: Request, gatewayId: string | undefined): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? gatewayId ?? crypto.randomUUID();
    const url = new URL(request.url);
    // A named stage puts /<stage> before the contract's path.
    const at = url.pathname.indexOf("/v1/");
    if (at < 0) return json(404, "not_found", "No such operation.", requestId);
    url.pathname = url.pathname.slice(at);
    const route = routes.find(
      (r) => (r.method === "*" || r.method === request.method) && (!r.pattern || r.pattern.test(url.pathname)),
    );
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
    },
    async lambdaHandler(event: HttpApiEvent): Promise<HttpApiResult> {
      let request: Request;
      try {
        request = toRequest(event);
      } catch {
        return fromResponse(json(400, "bad_request", "The request could not be read.", event.requestContext.requestId ?? crypto.randomUUID()));
      }
      return fromResponse(await dispatch(request, event.requestContext.requestId));
    },
  };
}

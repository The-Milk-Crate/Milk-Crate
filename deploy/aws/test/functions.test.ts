import { test } from "node:test";
import assert from "node:assert/strict";
import { lambdaFunctions, type HttpApiEvent } from "../src/functions.ts";

function event(over: Partial<HttpApiEvent> & { method?: string } = {}): HttpApiEvent {
  return {
    version: "2.0",
    rawPath: over.rawPath ?? "/v1/releases/abc",
    rawQueryString: over.rawQueryString ?? "",
    headers: { authorization: "Bearer t", "content-type": "application/json", ...(over.headers ?? {}) },
    cookies: over.cookies,
    body: over.body,
    isBase64Encoded: over.isBase64Encoded ?? false,
    requestContext: { domainName: "api.example", requestId: "gw-1", http: { method: over.method ?? "GET" } },
  };
}

test("an API Gateway event becomes a web-standard Request, and the handler gets its modules", async () => {
  const fns = lambdaFunctions();
  let seen: { url: string; method: string; auth: string | null; cookie: string | null; body: string; deps: unknown } | undefined;
  fns.handle("PATCH /v1/releases/{releaseId}", async (request, deps) => {
    seen = { url: request.url, method: request.method, auth: request.headers.get("authorization"), cookie: request.headers.get("cookie"), body: await request.text(), deps };
    return Response.json({ ok: true }, { status: 200 });
  }, { database: "db" });
  const result = await fns.lambdaHandler(event({ method: "PATCH", rawQueryString: "a=1&b=2", cookies: ["x=1", "y=2"], body: Buffer.from('{"title":"T"}').toString("base64"), isBase64Encoded: true }));
  assert.deepEqual(seen, { url: "https://api.example/v1/releases/abc?a=1&b=2", method: "PATCH", auth: "Bearer t", cookie: "x=1; y=2", body: '{"title":"T"}', deps: { database: "db" } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(result.isBase64Encoded, false);
  assert.match(result.headers["content-type"], /application\/json/);
});

test("a named stage before /v1/ is cut, so handlers see the contract's paths", async () => {
  const fns = lambdaFunctions();
  let path = "";
  fns.handle("GET /v1/releases/{releaseId}", async (r) => { path = new URL(r.url).pathname; return new Response(null, { status: 204 }); }, {});
  const result = await fns.lambdaHandler(event({ rawPath: "/prod/v1/releases/abc" }));
  assert.equal(path, "/v1/releases/abc");
  assert.equal(result.statusCode, 204);
  assert.equal(result.body, "");
});

test("no match is the contract's 404; a throw is a 500 with no details, logged with the request id", async () => {
  const logs: string[] = [];
  const fns = lambdaFunctions({ log: (m) => logs.push(m) });
  fns.handle("GET /v1/releases/{releaseId}", async () => { throw new Error("secret detail"); }, {});
  const missing = await fns.lambdaHandler(event({ rawPath: "/v1/nothing" }));
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(JSON.parse(missing.body), { code: "not_found", message: "No such operation.", requestId: "gw-1" });
  const wrongMethod = await fns.lambdaHandler(event({ method: "DELETE" }));
  assert.equal(wrongMethod.statusCode, 404);
  const boom = await fns.lambdaHandler(event({ headers: { "x-request-id": "req-9" } }));
  assert.equal(boom.statusCode, 500);
  assert.deepEqual(JSON.parse(boom.body), { code: "internal", message: "Something went wrong. Try again later.", requestId: "req-9" });
  assert.ok(!boom.body.includes("secret detail"));
  assert.match(logs[0], /request req-9 failed: Error: secret detail/);
});

test("binary bodies go back as base64; Set-Cookie headers go in cookies", async () => {
  const fns = lambdaFunctions();
  fns.handle("*", async () => {
    const headers = new Headers({ "content-type": "image/png" });
    headers.append("set-cookie", "a=1; Secure");
    headers.append("set-cookie", "b=2; Secure");
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers });
  }, {});
  const result = await fns.lambdaHandler(event());
  assert.equal(result.isBase64Encoded, true);
  assert.deepEqual([...Buffer.from(result.body, "base64")], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(result.cookies, ["a=1; Secure", "b=2; Secure"]);
  assert.equal(result.headers["set-cookie"], undefined);
});

test("bad routes are refused when registered", () => {
  assert.throws(() => lambdaFunctions().handle("get /v1/x", async () => new Response(), {}), /METHOD \/path/);
});

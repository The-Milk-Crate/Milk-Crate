import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { edgeFunctions } from "../src/functions.ts";

/** Registers handlers and returns the one function Deno.serve would get. */
async function served(register: (f: ReturnType<typeof edgeFunctions>) => void, logs: string[] = []) {
  let serveCalls = 0;
  let handler: ((r: Request) => Response | Promise<Response>) | undefined;
  const f = edgeFunctions({ serve: (h) => { serveCalls++; handler = h; }, log: (m) => logs.push(m) });
  register(f);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(serveCalls, 1, "Deno.serve is called once");
  return handler!;
}

describe("Edge Function adapter", () => {
  test("passes the Request and the modules to the shared handler and returns its Response", async () => {
    const deps = { name: "modules" };
    const seen: { url: string; method: string; body: string; auth: string | null; deps: unknown }[] = [];
    const serve = await served((f) =>
      f.handle("PATCH /v1/releases/{releaseId}", async (req, d) => {
        seen.push({ url: req.url, method: req.method, body: await req.text(), auth: req.headers.get("authorization"), deps: d });
        return new Response("done", { status: 200, headers: { "x-from": "handler" } });
      }, deps),
    );
    const res = await serve(new Request("http://edge/releases-update/v1/releases/abc", {
      method: "PATCH", headers: { authorization: "Bearer t" }, body: '{"title":"New"}',
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-from"), "handler");
    assert.equal(await res.text(), "done");
    assert.deepEqual(seen, [{ url: "http://edge/v1/releases/abc", method: "PATCH", body: '{"title":"New"}', auth: "Bearer t", deps }]);
  });

  test("also takes the /functions/v1/<name>/ prefix, and a trailing slash", async () => {
    const serve = await served((f) => f.handle("GET /v1/releases", async (req) => new Response(new URL(req.url).pathname), {}));
    assert.equal(await (await serve(new Request("https://p.supabase.co/functions/v1/api/v1/releases?state=live"))).text(), "/v1/releases");
    assert.equal((await serve(new Request("https://p.supabase.co/api/v1/releases/"))).status, 200);
  });

  test("anything else is the contract's 404 error shape", async () => {
    const serve = await served((f) => f.handle("GET /v1/releases/{releaseId}", async () => new Response("x"), {}));
    for (const req of [
      new Request("http://edge/fn/v1/releases/abc", { method: "DELETE" }),
      new Request("http://edge/fn/v1/releases/abc/tracks"),
      new Request("http://edge/fn/nothing"),
    ]) {
      const res = await serve(req);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.code, "not_found");
      assert.equal(typeof body.requestId, "string");
    }
  });

  test("a thrown error is a 500 with no details, logged with the request id", async () => {
    const logs: string[] = [];
    const serve = await served((f) => f.handle("*", async () => { throw new Error("secret detail"); }, {}), logs);
    const res = await serve(new Request("http://edge/fn/v1/plays", { method: "POST", headers: { "sb-request-id": "req-7" } }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { code: "internal", message: "Something went wrong. Try again later.", requestId: "req-7" });
    assert.match(logs[0], /req-7.*secret detail/s);
  });

  test("several handlers in one function, matched by method and path", async () => {
    const serve = await served((f) => {
      f.handle("GET /v1/uploads/{uploadId}", async () => new Response("get"), {});
      f.handle("POST /v1/uploads/{uploadId}/confirm", async () => new Response("confirm"), {});
    });
    assert.equal(await (await serve(new Request("http://e/f/v1/uploads/u1"))).text(), "get");
    assert.equal(await (await serve(new Request("http://e/f/v1/uploads/u1/confirm", { method: "POST" }))).text(), "confirm");
  });

  test("a bad route is refused when registered", () => {
    assert.throws(() => edgeFunctions({ serve: () => {} }).handle("releases", async () => new Response(), {}), /METHOD \/path/);
  });
});

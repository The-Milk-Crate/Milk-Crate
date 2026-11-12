import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { supabaseSecretsAndEmail } from "../src/secrets-email.ts";
import { fakeFetch } from "./helpers.ts";

const env = (vars: Record<string, string>) => (name: string) => vars[name];

describe("Secrets and email (Edge Function secrets, Resend mocked at the HTTP edge)", () => {
  test("getSecret reads a secret by name and refuses a missing one", async () => {
    const s = supabaseSecretsAndEmail({ env: env({ MY_KEY: "v" }), from: "x@y.z" });
    assert.equal(await s.getSecret("MY_KEY"), "v");
    await assert.rejects(s.getSecret("NOPE"), /NOPE is not set/);
    await assert.rejects(s.getSecret("bad name"), /bad secret name/);
  });

  test("sends each template through Resend with the key from the secrets", async () => {
    const resend = fakeFetch(() => Response.json({ id: "e1" }));
    const s = supabaseSecretsAndEmail({ env: env({ RESEND_API_KEY: "re_test" }), from: "Milk Crate <noreply@example.invalid>", fetch: resend.fetch });
    await s.sendTemplate({ template: "split_invitation", to: "p@example.invalid", data: { releaseTitle: "Blue", artistName: "Ana", inviteCode: "ABCD-1234", expiresAt: "2026-11-26" } });
    await s.sendTemplate({ template: "review_needs_changes", to: "a@example.invalid", data: { releaseTitle: "Blue", reason: "Cover is blurry." } });
    await s.sendTemplate({ template: "release_taken_down", to: "a@example.invalid", data: { releaseTitle: "Blue", reason: "Rights claim." } });
    assert.equal(resend.calls.length, 3);
    const req = resend.calls[0];
    assert.equal(req.url, "https://api.resend.com/emails");
    assert.equal(req.headers.get("authorization"), "Bearer re_test");
    const body = await req.json();
    assert.deepEqual(body.to, ["p@example.invalid"]);
    assert.equal(body.from, "Milk Crate <noreply@example.invalid>");
    assert.equal(body.subject, 'Ana invited you to a split on "Blue"');
    assert.match(body.text, /ABCD-1234/);
    assert.match((await resend.calls[1].json()).text, /Cover is blurry\./);
  });

  test("escapes HTML, keeps subjects on one line, and needs every field", async () => {
    const resend = fakeFetch(() => Response.json({ id: "e" }));
    const s = supabaseSecretsAndEmail({ env: env({ RESEND_API_KEY: "k" }), from: "a@b.c", fetch: resend.fetch });
    await s.sendTemplate({ template: "release_taken_down", to: "a@b.c", data: { releaseTitle: "<b>X</b>\r\nBcc: e@vil", reason: "<script>" } });
    const body = await resend.calls[0].json();
    assert.ok(!body.html.includes("<script>") && body.html.includes("&lt;script&gt;"));
    assert.ok(!/[\r\n]/.test(body.subject));
    await assert.rejects(s.sendTemplate({ template: "split_invitation", to: "a@b.c", data: { releaseTitle: "X" } }), /needs artistName, inviteCode, expiresAt/);
    await assert.rejects(s.sendTemplate({ template: "review_needs_changes", to: "not an address", data: { releaseTitle: "X", reason: "Y" } }), /bad email/);
  });

  test("a Resend error is an error", async () => {
    const s = supabaseSecretsAndEmail({ env: env({ RESEND_API_KEY: "k" }), from: "a@b.c", fetch: fakeFetch(() => new Response("quota", { status: 429 })).fetch });
    await assert.rejects(s.sendTemplate({ template: "release_taken_down", to: "a@b.c", data: { releaseTitle: "X", reason: "Y" } }), /\(429\)/);
  });
});

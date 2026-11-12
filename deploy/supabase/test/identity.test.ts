import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { supabaseIdentity } from "../src/identity.ts";
import { fakeFetch } from "./helpers.ts";

const URL_ = "https://abcd.supabase.co";
const USER = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";

describe("Identity (Supabase token)", () => {
  let key: CryptoKey;
  let other: CryptoKey;
  let jwks: ReturnType<typeof fakeFetch>;
  before(async () => {
    const pair = await generateKeyPair("ES256");
    key = pair.privateKey;
    other = (await generateKeyPair("ES256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
    jwks = fakeFetch((req) =>
      req.url === `${URL_}/auth/v1/.well-known/jwks.json` ? Response.json({ keys: [jwk] }) : new Response("no", { status: 404 }),
    );
  });

  const token = (claims: Record<string, unknown>, opts: { signer?: CryptoKey; iss?: string; exp?: string } = {}) =>
    new SignJWT({ role: "authenticated", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(USER)
      .setIssuer(opts.iss ?? `${URL_}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(opts.signer ?? key);

  const who = async (bearer: string | null, identity = supabaseIdentity({ supabaseUrl: URL_, fetch: jwks.fetch })) =>
    identity.whoIs(new Request("https://x/v1/releases", { headers: bearer === null ? {} : { authorization: bearer } }));

  test("reads account_type from the token's top-level claims (session C's hook)", async () => {
    assert.deepEqual(await who(`Bearer ${await token({ account_type: "artist" })}`), { userId: USER, accountType: "artist" });
    assert.ok(jwks.calls.some((r) => r.url.endsWith("/auth/v1/.well-known/jwks.json")));
  });

  test("never from user_metadata, which users can change", async () => {
    const t = await token({ account_type: "end_user", user_metadata: { account_type: "administrator" }, app_metadata: {} });
    assert.equal((await who(`Bearer ${t}`))!.accountType, "end_user");
    const noClaim = await token({ user_metadata: { account_type: "administrator" } });
    assert.equal((await who(`Bearer ${noClaim}`))!.accountType, "end_user");
  });

  test("null for no token, a malformed header, a bad signature, another issuer or an expired token", async () => {
    assert.equal(await who(null), null);
    assert.equal(await who("Basic abc"), null);
    assert.equal(await who("Bearer not-a-jwt"), null);
    assert.equal(await who(`Bearer ${await token({ account_type: "artist" }, { signer: other })}`), null);
    assert.equal(await who(`Bearer ${await token({ account_type: "artist" }, { iss: "https://evil.supabase.co/auth/v1" })}`), null);
    assert.equal(await who(`Bearer ${await token({ account_type: "artist" }, { exp: "-1m" })}`), null);
  });

  test("null for the anon or service key, an anonymous sign-in, or an unknown account type", async () => {
    assert.equal(await who(`Bearer ${await token({ role: "anon", account_type: "end_user" })}`), null);
    assert.equal(await who(`Bearer ${await token({ role: "service_role", account_type: "administrator" })}`), null);
    assert.equal(await who(`Bearer ${await token({ is_anonymous: true, account_type: "end_user" })}`), null);
    assert.equal(await who(`Bearer ${await token({ account_type: "superuser" })}`), null);
  });

  test("a project on the legacy HS256 secret works only when the secret is given", async () => {
    const secret = "legacy-test-secret-at-least-32-characters";
    const hs = await new SignJWT({ role: "authenticated", account_type: "internal" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER).setIssuer(`${URL_}/auth/v1`).setAudience("authenticated").setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    assert.equal(await who(`Bearer ${hs}`), null);
    const legacy = supabaseIdentity({ supabaseUrl: URL_, legacyJwtSecret: secret, fetch: jwks.fetch });
    assert.deepEqual(await who(`Bearer ${hs}`, legacy), { userId: USER, accountType: "internal" });
  });

  test("every account type in the contract", async () => {
    for (const t of ["end_user", "artist", "third_party", "administrator", "internal", "internal_accounting"]) {
      assert.equal((await who(`Bearer ${await token({ account_type: t })}`))!.accountType, t);
    }
  });
});

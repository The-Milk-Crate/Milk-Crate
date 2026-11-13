import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { COGNITO_GROUPS, accountTypeFromGroups, cognitoIdentity } from "../src/identity.ts";
import { wantedGroup } from "../src/accounts.ts";

const CLAIM = JSON.parse(readFileSync(join(import.meta.dirname, "../../../db/account-claim.json"), "utf8"));
const REGION = "eu-west-2";
const POOL = "eu-west-2_TestPool1";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
const SUB = "8f0e7c1a-1111-4000-8000-000000000001";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const identity = cognitoIdentity({ region: REGION, userPoolId: POOL, clientIds: ["client-1"], keys: createLocalJWKSet({ keys: [jwk] }) });

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; issuer?: string; exp?: string } = {}) {
  return new SignJWT({ token_use: "access", client_id: "client-1", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject((claims.sub as string) ?? SUB)
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}
const ask = (t?: string) => identity.whoIs(new Request("https://api.example/v1/releases", { headers: t ? { authorization: `Bearer ${t}` } : {} }));

test("the group table matches db/account-claim.json (names and precedence 1 to 5)", () => {
  assert.deepEqual(COGNITO_GROUPS.map((g) => ({ ...g })), CLAIM.cognitoGroups);
  assert.equal(CLAIM.noRow, "end_user");
  assert.equal(CLAIM.suspended, "end_user");
  assert.ok(!COGNITO_GROUPS.some((g) => (g.name as string) === "end_user"), "no end_user group");
  // The precedence numbers follow the claim's precedence list.
  assert.deepEqual(COGNITO_GROUPS.map((g) => g.name), CLAIM.precedence.filter((t: string) => t !== "end_user"));
});

test("each group gives its account type; no group gives end_user", async () => {
  for (const g of CLAIM.cognitoGroups) {
    assert.deepEqual(await ask(await token({ "cognito:groups": [g.name] })), { userId: SUB, accountType: g.name });
  }
  assert.deepEqual(await ask(await token({})), { userId: SUB, accountType: "end_user" });
  assert.deepEqual(await ask(await token({ "cognito:groups": [] })), { userId: SUB, accountType: "end_user" });
});

test("two groups at once: the lowest precedence number wins", async () => {
  assert.equal((await ask(await token({ "cognito:groups": ["artist", "administrator"] })))?.accountType, "administrator");
  assert.equal((await ask(await token({ "cognito:groups": ["third_party", "internal_accounting"] })))?.accountType, "internal_accounting");
  // Every pair, against the claim's own precedence list.
  for (const a of CLAIM.cognitoGroups) {
    for (const b of CLAIM.cognitoGroups) {
      const want = a.precedence <= b.precedence ? a.name : b.name;
      assert.equal(accountTypeFromGroups([b.name, a.name]), want);
    }
  }
  // A group that is not a claim group is ignored.
  assert.equal(accountTypeFromGroups(["beta-testers"]), "end_user");
  assert.equal(accountTypeFromGroups(["beta-testers", "artist"]), "artist");
});

test("the sync's group for a row: its type, none without a row or when suspended", () => {
  for (const g of CLAIM.cognitoGroups) {
    assert.equal(wantedGroup({ user_id: SUB, account_type: g.name, suspended: false }), g.name);
    assert.equal(wantedGroup({ user_id: SUB, account_type: g.name, suspended: true }), null);
  }
  assert.equal(wantedGroup(undefined), null);
  // And the claim of a user in no group is the claim's suspended/no-row value.
  assert.equal(accountTypeFromGroups([]), CLAIM.suspended);
});

test("null for no token, a bad token, another key, an expired token, the wrong issuer or client, or an ID token", async () => {
  assert.equal(await ask(), null);
  assert.equal(await identity.whoIs(new Request("https://x", { headers: { authorization: "Basic abc" } })), null);
  assert.equal(await ask("not.a.token"), null);
  assert.equal(await ask(await token({}, { key: other.privateKey })), null);
  assert.equal(await ask(await token({}, { exp: "-1m" })), null);
  assert.equal(await ask(await token({}, { issuer: "https://cognito-idp.eu-west-2.amazonaws.com/other" })), null);
  assert.equal(await ask(await token({ client_id: "client-2" })), null);
  assert.equal(await ask(await token({ token_use: "id", aud: "client-1", client_id: undefined })), null);
  assert.equal(await ask(await token({ sub: "not-a-uuid" })), null);
  assert.equal(await ask(await token({ "cognito:groups": "administrator" })), null);
});

test("an unsigned (alg none) or HS256 token is refused", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: SUB, iss: ISSUER, token_use: "access", client_id: "client-1", "cognito:groups": ["administrator"], exp: 9e9 })).toString("base64url");
  assert.equal(await ask(`${header}.${body}.`), null);
  const hs = await new SignJWT({ token_use: "access", client_id: "client-1", "cognito:groups": ["administrator"] })
    .setProtectedHeader({ alg: "HS256" }).setSubject(SUB).setIssuer(ISSUER).setExpirationTime("1h")
    .sign(new TextEncoder().encode("x".repeat(32)));
  assert.equal(await ask(hs), null);
});

test("the keys come from the pool's published JWKS", async () => {
  const seen: string[] = [];
  const fetching = cognitoIdentity({
    region: REGION,
    userPoolId: POOL,
    clientIds: ["client-1"],
    fetch: (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const t = await token({ "cognito:groups": ["artist"] });
  const caller = await fetching.whoIs(new Request("https://x", { headers: { authorization: `Bearer ${t}` } }));
  assert.equal(caller?.accountType, "artist");
  assert.deepEqual(seen, [`${ISSUER}/.well-known/jwks.json`]);
});

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AccountType, Caller, Identity } from "./core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Cognito groups and their precedence, from db/account-claim.json (session C). A test
 * checks this table against that file. There is no end_user group: no group means end_user.
 */
export const COGNITO_GROUPS: readonly { name: Exclude<AccountType, "end_user">; precedence: number }[] = [
  { name: "administrator", precedence: 1 },
  { name: "internal", precedence: 2 },
  { name: "internal_accounting", precedence: 3 },
  { name: "third_party", precedence: 4 },
  { name: "artist", precedence: 5 },
];

/**
 * The claim from a user's groups: the claim group with the lowest precedence number, or
 * `end_user` when the user is in none. Groups that are not claim groups are ignored.
 */
export function accountTypeFromGroups(groups: readonly string[]): AccountType {
  let best: { name: AccountType; precedence: number } | undefined;
  for (const g of COGNITO_GROUPS) {
    if (groups.includes(g.name) && (!best || g.precedence < best.precedence)) best = g;
  }
  return best?.name ?? "end_user";
}

export interface CognitoIdentityOptions {
  /** Such as eu-west-2. */
  region: string;
  /** Such as eu-west-2_AbCdEf123. */
  userPoolId: string;
  /** The app clients whose tokens are accepted. */
  clientIds: string[];
  /** Overrides the key lookup (tests). */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

/**
 * Who is calling, from the Cognito access token in `Authorization: Bearer ...`. The token is
 * checked against the pool's published keys (its JWKS), its issuer, `token_use` and app client.
 * The account type comes from `cognito:groups`, which only an administrator of the pool can
 * change (users cannot). Returns null for no token or a bad, expired or ID token.
 */
export function cognitoIdentity(options: CognitoIdentityOptions): Identity {
  const issuer = `https://cognito-idp.${options.region}.amazonaws.com/${options.userPoolId}`;
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      ...(options.fetch ? { [customFetch]: options.fetch } : {}),
    });
  if (options.clientIds.length === 0) throw new Error("cognitoIdentity needs at least one app client id");

  return {
    async whoIs(request: Request): Promise<Caller | null> {
      const auth = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(auth.trim());
      if (!match) return null;
      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await jwtVerify(match[1], keys, { issuer, algorithms: ["RS256"] }));
      } catch {
        return null;
      }
      // Access tokens only: they carry client_id, not aud.
      if (claims.token_use !== "access") return null;
      if (typeof claims.client_id !== "string" || !options.clientIds.includes(claims.client_id)) return null;
      const sub = claims.sub;
      if (typeof sub !== "string" || !UUID.test(sub)) return null;
      const groups = claims["cognito:groups"];
      if (groups !== undefined && (!Array.isArray(groups) || groups.some((g) => typeof g !== "string"))) return null;
      return { userId: sub.toLowerCase(), accountType: accountTypeFromGroups((groups as string[] | undefined) ?? []) };
    },
  };
}

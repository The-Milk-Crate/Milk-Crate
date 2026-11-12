import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AccountType, Caller, Identity } from "./core.ts";

const ACCOUNT_TYPES: readonly AccountType[] = [
  "end_user", "artist", "third_party", "administrator", "internal", "internal_accounting",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupabaseIdentityOptions {
  /** The project URL, such as https://<ref>.supabase.co. */
  supabaseUrl: string;
  /**
   * The legacy HS256 JWT secret, only for a project that still signs with it. Projects on the
   * newer signing keys need nothing here: the public keys come from the project's JWKS.
   */
  legacyJwtSecret?: string;
  /** Overrides the key lookup (tests). */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

/**
 * Who is calling, from the Supabase access token in `Authorization: Bearer ...`.
 * The account type is the top-level `account_type` claim that session C's hook writes. It is
 * never read from `user_metadata`, which users can change.
 */
export function supabaseIdentity(options: SupabaseIdentityOptions): Identity {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const jwks =
    options.keys ??
    createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      ...(options.fetch ? { [customFetch]: options.fetch } : {}),
    });
  const secret = options.legacyJwtSecret ? new TextEncoder().encode(options.legacyJwtSecret) : undefined;
  const algorithms = secret ? ["ES256", "RS256", "HS256"] : ["ES256", "RS256"];
  const key: JWTVerifyGetKey = async (header, token) => {
    if (header.alg === "HS256") {
      if (!secret) throw new Error("HS256 token but no legacy secret");
      return secret;
    }
    return jwks(header, token);
  };

  return {
    async whoIs(request: Request): Promise<Caller | null> {
      const auth = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(auth.trim());
      if (!match) return null;
      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await jwtVerify(match[1], key, { issuer, audience: "authenticated", algorithms }));
      } catch {
        return null;
      }
      const sub = claims.sub;
      if (typeof sub !== "string" || !UUID.test(sub)) return null;
      // Only a signed-in account: not the anon or service key, not an anonymous sign-in.
      if (claims.role !== "authenticated" || claims.is_anonymous === true) return null;
      const type = claims.account_type;
      // No claim: a token from before the hook was on. The lowest type; staff endpoints check
      // the api_accounts row anyway. An unknown value is a bad token.
      if (type === undefined) return { userId: sub, accountType: "end_user" };
      if (typeof type !== "string" || !ACCOUNT_TYPES.includes(type as AccountType)) return null;
      return { userId: sub, accountType: type as AccountType };
    },
  };
}

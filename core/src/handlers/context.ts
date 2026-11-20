import type { AccountType, Caller, Handler, Modules, Queryable } from "../platform/index.ts";
import { ApiFailure, errorResponse, forbidden, mapModuleError, unauthorized } from "./http.ts";

/** What the handlers take besides the modules. Tests pass their own clock and random source. */
export interface CoreOptions {
  /** The clock. Default: the system clock. */
  now?: () => Date;
  /** Random bytes, for invite codes. Default: `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
  /** A new request id. Default: `crypto.randomUUID`. A request's own `x-request-id` wins. */
  newRequestId?: () => string;
  /** Invitations sent per party per UTC day, the first one included. Default 5. */
  inviteDailyLimit?: number;
  /** Smallest cover side in pixels. Default 1400 (decided by K Marcus). */
  minCoverPixels?: number;
  /** Where unexpected errors are written. Default: `console.error`. */
  log?: (message: string) => void;
}

export interface Settings {
  now: () => Date;
  randomBytes: (length: number) => Uint8Array;
  newRequestId: () => string;
  inviteDailyLimit: number;
  minCoverPixels: number;
  log: (message: string) => void;
}

export function settings(options: CoreOptions = {}): Settings {
  return {
    now: options.now ?? (() => new Date()),
    randomBytes:
      options.randomBytes ??
      ((length) => {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return bytes;
      }),
    newRequestId: options.newRequestId ?? (() => crypto.randomUUID()),
    inviteDailyLimit: options.inviteDailyLimit ?? 5,
    minCoverPixels: options.minCoverPixels ?? 1400,
    log: options.log ?? ((message) => console.error(message)),
  };
}

/** What one request's handler code gets. */
export interface Context {
  request: Request;
  modules: Modules;
  settings: Settings;
  requestId: string;
  params: Record<string, string>;
}

/** Path patterns as the contract writes them: "/v1/releases/{releaseId}". */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = pathname.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const name = /^\{([A-Za-z]+)\}$/.exec(want[i]);
    if (name) {
      if (!got[i]) return null;
      try {
        params[name[1]] = decodeURIComponent(got[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

export interface Operation {
  operationId: string;
  /** "METHOD /v1/path/{param}", as session E's `serveOperation` and F's routes.json take it. */
  route: string;
  method: string;
  path: string;
  handler: Handler<Modules>;
}

/**
 * One operation: the route it serves and its code. The handler reads its own path parameters,
 * so it works behind the router or as a function of its own. Any error becomes the contract's
 * `Error`; one that is not ours is a 500 with no details, written to the log.
 */
export function operation(
  operationId: string,
  route: string,
  settingsValue: Settings,
  run: (ctx: Context) => Promise<Response>,
): Operation {
  const [method, path] = route.split(" ");
  const handler: Handler<Modules> = async (request, modules) => {
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || settingsValue.newRequestId();
    try {
      const params = matchPath(path, new URL(request.url).pathname);
      if (request.method !== method || !params) {
        throw new ApiFailure(404, "not_found", "No such operation.");
      }
      return await run({ request, modules, settings: settingsValue, requestId, params });
    } catch (error) {
      const failure = mapModuleError(error);
      if (failure) return errorResponse(failure, requestId);
      settingsValue.log(
        `request ${requestId} (${operationId}) failed: ${(error as Error)?.stack ?? String(error)}`,
      );
      return errorResponse(new ApiFailure(500, "internal", "Something went wrong. Try again later."), requestId);
    }
  };
  return { operationId, route, method, path, handler };
}

/** The caller's api_accounts row, if any. */
export interface AccountRow {
  account_type: Exclude<AccountType, "end_user">;
  suspended: boolean;
  email: string | null;
  artist_id: string | null;
  artist_name: string | null;
}

export interface Who {
  userId: string;
  /** The type the token says. */
  tokenType: AccountType;
  /**
   * The type the handlers act on. The token's type when the api_accounts row exists, has that
   * type and is not suspended; otherwise `end_user` (settled with session C). `end_user` needs
   * no row.
   */
  type: AccountType;
  row: AccountRow | null;
}

export async function signedIn(ctx: Context): Promise<Caller> {
  const caller = await ctx.modules.identity.whoIs(ctx.request);
  if (!caller) throw unauthorized();
  return caller;
}

export async function accountRow(db: Queryable, userId: string): Promise<AccountRow | null> {
  const rows = await db.query<AccountRow>(
    `select account_type, suspended, email, artist_id::text as artist_id, artist_name
       from public.api_accounts where user_id = $1::uuid`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Who is calling, checked against the api_accounts row. A removed, changed or suspended role
 * acts as `end_user` at once; a new role waits for the token refresh.
 */
export async function whoIsCalling(ctx: Context, db: Queryable = ctx.modules.database): Promise<Who> {
  const caller = await signedIn(ctx);
  if (caller.accountType === "end_user") {
    return { userId: caller.userId, tokenType: "end_user", type: "end_user", row: null };
  }
  const row = await accountRow(db, caller.userId);
  const type = row && !row.suspended && row.account_type === caller.accountType ? caller.accountType : "end_user";
  return { userId: caller.userId, tokenType: caller.accountType, type, row };
}

/** 403 unless the caller's type is one the operation allows (its `x-account-types`). */
export function allow(who: Who, types: readonly AccountType[]): void {
  if (!types.includes(who.type)) throw forbidden();
}

export const STAFF_READERS: readonly AccountType[] = ["administrator", "internal"];

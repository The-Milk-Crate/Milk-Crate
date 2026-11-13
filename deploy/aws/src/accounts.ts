import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Database } from "./core.ts";
import type { Sender } from "./aws.ts";
import { COGNITO_GROUPS } from "./identity.ts";

/**
 * The account source on AWS is session B's `api_accounts` table. These keep Cognito in step:
 * each user is in exactly the group named by their row's `account_type`, and in no group when
 * there is no row or the row is suspended (claim `end_user`, settled with session C).
 * Rows are written by K Marcus or a later admin tool, never by users.
 */
export interface AccountsDeps {
  database: Database;
  /** A Cognito Identity Provider client. */
  cognito: Sender;
  userPoolId: string;
  log?: (message: string) => void;
}

export interface AccountRow {
  user_id: string;
  account_type: string;
  suspended: boolean;
}

const CLAIM_GROUPS = new Set<string>(COGNITO_GROUPS.map((g) => g.name));

/** The group a row asks for: its type, or none when there is no row or it is suspended. */
export function wantedGroup(row: AccountRow | undefined): string | null {
  if (!row || row.suspended) return null;
  return CLAIM_GROUPS.has(row.account_type) ? row.account_type : null;
}

async function groupsOf(deps: AccountsDeps, username: string): Promise<string[]> {
  const groups: string[] = [];
  let token: string | undefined;
  do {
    const out = await deps.cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: deps.userPoolId, Username: username, Limit: 60, NextToken: token }),
    );
    for (const g of out.Groups ?? []) if (g.GroupName) groups.push(g.GroupName);
    token = out.NextToken;
  } while (token);
  return groups;
}

/**
 * Puts one user in the group their row names and takes them out of every other group.
 * Returns what changed.
 */
export async function syncUser(
  deps: AccountsDeps,
  user: { username: string; sub: string },
  row: AccountRow | undefined,
): Promise<{ added: string[]; removed: string[] }> {
  const want = wantedGroup(row);
  const have = await groupsOf(deps, user.username);
  const added: string[] = [];
  const removed: string[] = [];
  if (want && !have.includes(want)) {
    await deps.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: deps.userPoolId, Username: user.username, GroupName: want }));
    added.push(want);
  }
  for (const g of have) {
    if (g === want) continue;
    await deps.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: deps.userPoolId, Username: user.username, GroupName: g }));
    removed.push(g);
  }
  return { added, removed };
}

async function rowsFor(deps: AccountsDeps, subs: string[]): Promise<Map<string, AccountRow>> {
  if (subs.length === 0) return new Map();
  // A list goes as JSON text (the Data API has no array parameters).
  const rows = await deps.database.query<AccountRow>(
    `select user_id::text as user_id, account_type, suspended from public.api_accounts
      where user_id in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
    [subs],
  );
  return new Map(rows.map((r) => [r.user_id.toLowerCase(), r]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The whole pool, 60 users at a time: each page's rows in one query, then each user's groups.
 * Run on a schedule (every 15 minutes) and by hand after writing rows. Returns counts.
 */
export async function syncAccounts(deps: AccountsDeps): Promise<{ users: number; added: number; removed: number }> {
  const log = deps.log ?? ((m: string) => console.log(m));
  let token: string | undefined;
  const totals = { users: 0, added: 0, removed: 0 };
  do {
    const out = await deps.cognito.send(
      new ListUsersCommand({ UserPoolId: deps.userPoolId, Limit: 60, PaginationToken: token, AttributesToGet: ["sub"] }),
    );
    const users = (out.Users ?? [])
      .map((u: { Username?: string; Attributes?: { Name?: string; Value?: string }[] }) => ({
        username: u.Username ?? "",
        sub: (u.Attributes?.find((a) => a.Name === "sub")?.Value ?? "").toLowerCase(),
      }))
      .filter((u: { username: string; sub: string }) => u.username && UUID.test(u.sub));
    const rows = await rowsFor(deps, users.map((u: { sub: string }) => u.sub));
    for (const user of users) {
      const change = await syncUser(deps, user, rows.get(user.sub));
      totals.users++;
      totals.added += change.added.length;
      totals.removed += change.removed.length;
      if (change.added.length || change.removed.length) {
        log(`user ${user.sub}: added ${change.added.join(", ") || "none"}; removed ${change.removed.join(", ") || "none"}`);
      }
    }
    token = out.PaginationToken;
  } while (token);
  return totals;
}

/** One user by Cognito `sub` (for example after writing their row). */
export async function syncOneAccount(deps: AccountsDeps, sub: string): Promise<{ added: string[]; removed: string[] }> {
  if (!UUID.test(sub)) throw new Error("a user id is a Cognito sub (a UUID)");
  const out = await deps.cognito.send(
    new ListUsersCommand({ UserPoolId: deps.userPoolId, Filter: `sub = "${sub.toLowerCase()}"`, Limit: 1 }),
  );
  const username = out.Users?.[0]?.Username;
  if (!username) throw new Error(`no Cognito user with sub ${sub}`);
  const rows = await rowsFor(deps, [sub.toLowerCase()]);
  return syncUser(deps, { username, sub: sub.toLowerCase() }, rows.get(sub.toLowerCase()));
}

/** The parts of Cognito's post-confirmation event the trigger reads. */
export interface PostConfirmationEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: { userAttributes: Record<string, string | undefined> };
  [key: string]: unknown;
}

/**
 * Cognito's post-confirmation trigger. Writes the user's email into their `api_accounts` row
 * where one exists (it never inserts a row), then syncs their group. It never throws: a failed
 * trigger would stop the user's sign-up, and the scheduled sync puts the group right later.
 */
export async function postConfirmation<E extends PostConfirmationEvent>(deps: AccountsDeps, event: E): Promise<E> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const attrs = event.request?.userAttributes ?? {};
  const sub = (attrs.sub ?? "").toLowerCase();
  if (!UUID.test(sub)) {
    log("post-confirmation: no sub on the event");
    return event;
  }
  try {
    const email = attrs.email;
    if (email && attrs.email_verified !== "false") {
      await deps.database.query(
        "update public.api_accounts set email = $2::text where user_id = $1::uuid and email is distinct from $2::text",
        [sub, email],
      );
    }
    const rows = await rowsFor(deps, [sub]);
    await syncUser(deps, { username: event.userName, sub }, rows.get(sub));
  } catch (error) {
    log(`post-confirmation for ${sub} failed: ${(error as Error)?.message ?? String(error)}`);
  }
  return event;
}

// putRights, resendInvitation, getInvitation and respondToSplit.
import type { Modules, Queryable, ReleaseState } from "../platform/index.ts";
import { allow, operation, whoIsCalling, type Context, type Settings } from "./context.ts";
import { ApiFailure, conflict, forbidden, json, noContent, notFound, tooMany, unprocessable } from "./http.ts";
import { ownRelease } from "./releases.ts";
import {
  arrayField,
  emailField,
  enumField,
  objectField,
  pathUuid,
  percentField,
  readJsonObject,
  stringField,
  textField,
  uuidField,
} from "./validate.ts";
import { iso, partyRows, partyView, type PartyRow } from "./views.ts";

const RIGHTS_EDITABLE: readonly ReleaseState[] = ["draft", "uploading", "processing", "awaiting_splits", "needs_changes"];
const INVITEES = ["end_user", "artist", "third_party"] as const;
/** Session B locks a party for the rest of the hour after 10 wrong codes. */
const WRONG_CODE_WINDOW_SECONDS = 3600;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the UTF-8 code, lowercase hex (settled with session C). */
export async function hashInviteCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return toHex(new Uint8Array(digest));
}

/** A new single-use code: 32 random bytes, base64url (43 characters). */
export function newInviteCode(s: Settings): string {
  const bytes = s.randomBytes(32);
  if (bytes.length !== 32) throw new Error("randomBytes must return the length asked for");
  return base64url(bytes);
}

/** "2026-12-04 18:23 UTC", for the email. */
function readableTime(isoTime: string): string {
  return `${isoTime.slice(0, 10)} ${isoTime.slice(11, 16)} UTC`;
}

function secondsToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

interface Invite {
  releaseId: string;
  partyId: string;
  to: string;
  code: string;
  expiresAt: string;
}

/**
 * What `api_issue_invite` answers. Besides the per-party daily limit (`rate_limited`), three
 * caps (finding M1, session J1): 20 parties invited per release, all time (`release_limited`);
 * 50 invitations per artist per UTC day (`artist_limited`); 3 per recipient address per UTC
 * day (`address_limited`).
 */
type IssueStatus =
  | "issued"
  | "not_found"
  | "not_invited"
  | "taken_down"
  | "rate_limited"
  | "release_limited"
  | "artist_limited"
  | "address_limited";

/**
 * Issues a code for each party through session B's `api_issue_invite`, inside the caller's
 * transaction. Returns what to email once it commits, and the statuses.
 */
async function issueInvite(
  tx: Queryable,
  s: Settings,
  partyId: string,
): Promise<{ status: IssueStatus; code?: string; expiresAt?: string }> {
  const code = newInviteCode(s);
  const [row] = await tx.query<{ status: IssueStatus; expires_at: string | null }>(
    `select i.status, ${iso("i.expires_at")} as expires_at from public.api_issue_invite($1::uuid, $2::text, $3::integer) i`,
    [partyId, await hashInviteCode(code), s.inviteDailyLimit],
  );
  if (row.status !== "issued") return { status: row.status };
  return { status: "issued", code, expiresAt: row.expires_at ?? "" };
}

async function sendInvites(modules: Modules, s: Settings, invites: Invite[], releaseTitle: string, artistName: string) {
  for (const invite of invites) {
    try {
      await modules.secretsAndEmail.sendTemplate({
        template: "split_invitation",
        to: invite.to,
        // The release id and party id let the invitee find the invitation (getInvitation and
        // respondToSplit take them in the path). The code stays in the email body only.
        data: {
          releaseTitle,
          artistName,
          inviteCode: invite.code,
          expiresAt: readableTime(invite.expiresAt),
          releaseId: invite.releaseId,
          partyId: invite.partyId,
        },
      });
    } catch (error) {
      // The party has a code nobody received; the owner can resend it.
      s.log(`invitation email for party ${invite.partyId} failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }
}

interface PartyInput {
  id: string | null;
  side: "recording" | "composition";
  role: string;
  name: string;
  email: string | null;
  hundredths: number;
}

function readParties(body: Record<string, unknown>): PartyInput[] {
  return arrayField(body.parties, "parties", 1, 100).map((item, i) => {
    const p = objectField(item, `parties[${i}]`);
    return {
      id: p.id === undefined ? null : uuidField(p.id, `parties[${i}].id`),
      side: enumField(p.side, `parties[${i}].side`, ["recording", "composition"] as const),
      role: textField(p.role, `parties[${i}].role`, 1, 100),
      name: textField(p.name, `parties[${i}].name`, 1, 200),
      email: p.email === undefined || p.email === null ? null : emailField(p.email, `parties[${i}].email`),
      hundredths: percentField(p.percent, `parties[${i}].percent`),
    };
  });
}

function invitationStatusFailure(status: string): ApiFailure | null {
  switch (status) {
    case "ok":
      return null;
    case "wrong_code":
      return new ApiFailure(403, "wrong_code", "That invite code is not right for this invitation.");
    case "expired":
      return new ApiFailure(403, "expired", "That invite code has expired. Ask the artist to send a new one.");
    case "replied":
      return conflict("already_replied", "This invitation was already answered.");
    case "taken_down":
      return conflict("taken_down", "This release was taken down.");
    case "rate_limited":
      return tooMany("rate_limited", "Too many wrong codes for this invitation. Try again in an hour.", WRONG_CODE_WINDOW_SECONDS);
    case "not_found":
      return notFound("No such invitation.");
    default:
      throw new Error(`unknown invitation status ${status}`);
  }
}

export function rightsOperations(s: Settings) {
  const putRights = operation("putRights", "PUT /v1/releases/{releaseId}/rights", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const body = await readJsonObject(ctx.request);
    const parties = readParties(body);

    // The 100-percent rule: each side adds up to exactly 100.
    for (const side of ["recording", "composition"] as const) {
      const total = parties.filter((p) => p.side === side).reduce((sum, p) => sum + p.hundredths, 0);
      if (total !== 10000) {
        throw unprocessable("shares_not_100", `${side} shares add up to ${total / 100}, not 100.`, { side });
      }
    }

    const result = await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, ["artist"]);
      const release = await ownRelease(tx, who, releaseId, true);
      if (!RIGHTS_EDITABLE.includes(release.state)) {
        throw conflict("not_editable", `Rights cannot change while ${release.state}.`);
      }
      const existing = new Map((await partyRows(tx, releaseId)).map((p) => [p.id, p]));
      // The owner's own share is named from the artist profile; the name sent is ignored
      // (finding L2). The contract still asks for one.
      const ownerName = who.row?.artist_name ?? null;

      const seen = new Set<string>();
      const ownerSides = new Set<string>();
      for (const [i, p] of parties.entries()) {
        if (p.id !== null) {
          if (seen.has(p.id)) throw unprocessable("bad_parties", `parties[${i}].id is listed more than once.`);
          seen.add(p.id);
          if (!existing.has(p.id)) throw unprocessable("bad_parties", `parties[${i}].id is not a party of this release.`);
        }
        // The owner's own share is the party with no email (a new party), or a kept party that
        // already is the owner's. It is accepted at once and gets no invitation.
        const isOwner = p.id !== null ? existing.get(p.id)!.is_owner : p.email === null;
        if (isOwner && p.email !== null) {
          throw unprocessable("bad_parties", `parties[${i}] is your own share, which has no email.`);
        }
        if (!isOwner && p.email === null) {
          throw unprocessable("email_needed", `parties[${i}] needs an email for the invitation.`);
        }
        // At most one owner share (no email) per side: any other party is asked by email.
        if (isOwner) {
          if (ownerSides.has(p.side)) {
            throw unprocessable("bad_parties", `parties[${i}] is a second share with no email on the ${p.side} side; only your own share has no email.`);
          }
          ownerSides.add(p.side);
        }
      }

      const keptIds = parties.filter((p) => p.id !== null).map((p) => p.id as string);
      await tx.query(
        `delete from public.api_parties p
          where p.release_id = $1::uuid
            and p.id not in (select k::uuid from jsonb_array_elements_text($2::jsonb) as k)`,
        [releaseId, JSON.stringify(keptIds)],
      );

      // Each party's place in the request is its position, so getRelease keeps the order sent.
      for (const [position, p] of parties.entries()) {
        const percent = (p.hundredths / 100).toFixed(2);
        const isOwner = p.id !== null ? existing.get(p.id)!.is_owner : p.email === null;
        const name = isOwner && ownerName ? ownerName : p.name;
        if (p.id !== null) {
          // Session B's trigger sends a changed party back to invited and voids its code. An
          // unchanged party keeps its state and code; a new position alone changes neither.
          await tx.query(
            `update public.api_parties p
                set side = $2::text, role = $3::text, name = $4::text, email = $5::text, percent = $6::numeric,
                    position = $7::integer
              where p.id = $1::uuid
                and (p.side, p.role, p.name, p.email, p.percent, p.position)
                    is distinct from ($2::text, $3::text, $4::text, $5::text, $6::numeric, $7::integer)`,
            [p.id, p.side, p.role, name, p.email, percent, position],
          );
        } else {
          await tx.query(
            `insert into public.api_parties (release_id, side, role, name, email, percent, is_owner, position)
             values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::numeric, $7::boolean, $8::integer)`,
            [releaseId, p.side, p.role, name, p.email, percent, p.email === null, position],
          );
        }
      }

      // Everyone still invited without a code gets one: new parties, changed parties, and any
      // whose earlier send was over the daily limit.
      const invites: Invite[] = [];
      for (const party of await partyRows(tx, releaseId)) {
        if (party.is_owner || party.state !== "invited" || !party.email || party.has_code) continue;
        const issued = await issueInvite(tx, ctx.settings, party.id);
        if (issued.status === "issued") {
          invites.push({ releaseId, partyId: party.id, to: party.email, code: issued.code!, expiresAt: issued.expiresAt! });
        } else {
          // Over a limit or a cap: the party is saved, no email goes (putRights has no 429).
          ctx.settings.log(`party ${party.id}: invitation not sent (${issued.status}); the owner can resend it later`);
        }
      }

      // needs_changes → awaiting_splits once processing is done (every master confirmed; a new
      // upload would have moved the release to uploading instead).
      if (release.state === "needs_changes") {
        await tx.query(
          `update public.api_releases r set state = 'awaiting_splits'
            where r.id = $1::uuid and r.state = 'needs_changes'
              and not exists (select 1 from public.api_tracks t where t.release_id = r.id and t.master_confirmed_at is null)`,
          [releaseId],
        );
      }

      const saved = await partyRows(tx, releaseId);
      return { invites, saved, title: release.title, artistName: who.row?.artist_name ?? "" };
    });

    await sendInvites(ctx.modules, ctx.settings, result.invites, result.title, result.artistName);
    return json(200, { parties: result.saved.map((p) => partyView(p)) }, ctx.requestId);
  });

  const resendInvitation = operation(
    "resendInvitation",
    "POST /v1/releases/{releaseId}/rights/parties/{partyId}/resend",
    s,
    async (ctx) => {
      const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
      const partyId = pathUuid(ctx.params.partyId, "partyId");
      const result = await ctx.modules.database.transaction(async (tx) => {
        const who = await whoIsCalling(ctx, tx);
        allow(who, ["artist"]);
        const release = await ownRelease(tx, who, releaseId, true);
        const party = (await partyRows(tx, releaseId)).find((p) => p.id === partyId);
        if (!party) throw notFound("No such party on this release.");
        if (party.is_owner || !party.email) throw conflict("not_invited", "Your own share has no invitation.");
        const issued = await issueInvite(tx, ctx.settings, partyId);
        return { issued, party, title: release.title, artistName: who.row?.artist_name ?? "" };
      });
      const { issued, party } = result;
      if (issued.status === "not_found") throw notFound("No such party on this release.");
      if (issued.status === "not_invited") throw conflict("not_invited", "This party already replied.");
      if (issued.status === "taken_down") throw conflict("taken_down", "This release was taken down.");
      if (issued.status === "rate_limited") {
        throw tooMany(
          "rate_limited",
          `This invitation was sent ${ctx.settings.inviteDailyLimit} times today. Try again tomorrow (UTC).`,
          secondsToNextUtcDay(ctx.settings.now()),
        );
      }
      if (issued.status === "artist_limited") {
        throw tooMany("rate_limited", "You sent the most invitations allowed today. Try again tomorrow (UTC).", secondsToNextUtcDay(ctx.settings.now()));
      }
      if (issued.status === "address_limited") {
        throw tooMany("rate_limited", "This address got the most invitations allowed today. Try again tomorrow (UTC).", secondsToNextUtcDay(ctx.settings.now()));
      }
      if (issued.status === "release_limited") {
        // An all-time cap: waiting does not help, so no Retry-After.
        throw new ApiFailure(429, "rate_limited", "This release invited the most parties allowed. No more invitations can be sent for it.");
      }
      await sendInvites(
        ctx.modules,
        ctx.settings,
        [{ releaseId, partyId, to: party.email!, code: issued.code!, expiresAt: issued.expiresAt! }],
        result.title,
        result.artistName,
      );
      return noContent(ctx.requestId);
    },
  );

  async function inviteeStart(ctx: Context) {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const partyId = pathUuid(ctx.params.partyId, "partyId");
    const body = await readJsonObject(ctx.request);
    const who = await whoIsCalling(ctx);
    // Staff accounts cannot answer an invitation (403), whatever the code.
    if (!(INVITEES as readonly string[]).includes(who.type)) throw forbidden();
    return { releaseId, partyId, body, who };
  }

  const getInvitation = operation(
    "getInvitation",
    "POST /v1/releases/{releaseId}/rights/parties/{partyId}/invitation",
    s,
    async (ctx) => {
      const { releaseId, partyId, body } = await inviteeStart(ctx);
      const code = stringField(body.inviteCode, "inviteCode", 16, 256);
      // One statement, so a wrong code is counted (it commits) even though the answer is 403.
      const [row] = await ctx.modules.database.query<{
        status: string;
        release_title: string | null;
        artist_name: string | null;
        release_date: string | null;
        track_titles: string | null;
        side: string | null;
        role: string | null;
        percent: string | null;
        party_state: string | null;
      }>(
        `select g.status, g.release_title, g.artist_name, to_char(g.release_date, 'YYYY-MM-DD') as release_date,
                g.track_titles::text as track_titles, g.side, g.role, g.percent::text as percent, g.party_state
           from public.api_get_invitation($1::uuid, $2::uuid, $3::text) g`,
        [releaseId, partyId, await hashInviteCode(code)],
      );
      const failure = invitationStatusFailure(row.status);
      if (failure) throw failure;
      return json(
        200,
        {
          releaseTitle: row.release_title,
          artistName: row.artist_name,
          releaseDate: row.release_date,
          trackTitles: JSON.parse(row.track_titles ?? "[]") as string[],
          party: { side: row.side, role: row.role, percent: Number(row.percent), state: row.party_state },
        },
        ctx.requestId,
      );
    },
  );

  const respondToSplit = operation(
    "respondToSplit",
    "POST /v1/releases/{releaseId}/rights/parties/{partyId}/respond",
    s,
    async (ctx) => {
      const { releaseId, partyId, body, who } = await inviteeStart(ctx);
      const response = enumField(body.response, "response", ["accept", "decline"] as const);
      const code = stringField(body.inviteCode, "inviteCode", 16, 256);
      // Session B checks hash, expiry and used-at and links the signed-in account, in one
      // statement; a wrong code is counted and committed.
      const [row] = await ctx.modules.database.query<{ status: string }>(
        "select r.status from public.api_respond_to_invite($1::uuid, $2::uuid, $3::text, $4::uuid, $5::text) r",
        [releaseId, partyId, await hashInviteCode(code), who.userId, response],
      );
      const failure = invitationStatusFailure(row.status);
      if (failure) throw failure;
      // Only the invitee's own party: never other parties' names, emails or shares.
      const own = (await partyRows(ctx.modules.database, releaseId)).filter((p: PartyRow) => p.id === partyId);
      return json(200, { parties: own.map((p) => partyView(p, false)) }, ctx.requestId);
    },
  );

  return { putRights, resendInvitation, getInvitation, respondToSplit };
}

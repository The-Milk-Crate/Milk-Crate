// createRelease, getRelease, getPublicRelease, updateRelease, listReleases, submitRelease,
// reviewRelease, publishRelease and takedownRelease.
import type { Modules, Queryable, ReleaseState } from "../platform/index.ts";
import { allow, operation, STAFF_READERS, whoIsCalling, type Context, type Settings, type Who } from "./context.ts";
import { badRequest, conflict, json, notFound, unprocessable } from "./http.ts";
import {
  arrayField,
  dateField,
  enumField,
  integerField,
  isUuid,
  objectField,
  pathUuid,
  readJsonObject,
  stringField,
  textField,
  uuidField,
} from "./validate.ts";
import { day, fullRelease, iso, releaseRow, type ReleaseRow } from "./views.ts";

export const RELEASE_STATES: readonly ReleaseState[] = [
  "draft",
  "uploading",
  "processing",
  "awaiting_splits",
  "awaiting_review",
  "needs_changes",
  "scheduled",
  "live",
  "failed",
  "taken_down",
];

const DETAILS_EDITABLE: readonly ReleaseState[] = ["draft", "uploading", "awaiting_splits", "needs_changes"];

/**
 * The caller's own release (an artist). Another artist's release, or none, is 404 (settled:
 * hidden, not 403).
 */
export async function ownRelease(db: Queryable, who: Who, releaseId: string, lock = false): Promise<ReleaseRow> {
  const release = await releaseRow(db, releaseId, lock);
  if (!release || release.owner_id !== who.userId) throw notFound("No such release.");
  return release;
}

async function mustRead(db: Queryable, releaseId: string) {
  const view = await fullRelease(db, releaseId);
  if (!view) throw notFound("No such release.");
  return view;
}

/** Plain words to the owner. A failed email is written to the log; the call still succeeds. */
export async function emailOwner(
  modules: Modules,
  log: Settings["log"],
  releaseId: string,
  template: "review_needs_changes" | "release_taken_down",
  data: Record<string, string>,
): Promise<boolean> {
  try {
    const rows = await modules.database.query<{ email: string | null }>(
      `select a.email from public.api_releases r join public.api_accounts a on a.user_id = r.owner_id
        where r.id = $1::uuid`,
      [releaseId],
    );
    const to = rows[0]?.email;
    if (!to) {
      log(`no email for the owner of release ${releaseId}; ${template} not sent`);
      return false;
    }
    await modules.secretsAndEmail.sendTemplate({ template, to, data });
    return true;
  } catch (error) {
    log(`sending ${template} for release ${releaseId} failed: ${(error as Error)?.message ?? String(error)}`);
    return false;
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const value = JSON.parse(text) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      value[0].length <= 64 &&
      /^\d{4}-\d{2}-\d{2}[ T][0-9:.+-]+$/.test(value[0]) &&
      isUuid(value[1])
    ) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the 400.
  }
  throw badRequest("cursor is not one this API gave out.", { field: "cursor" });
}

export function releaseOperations(s: Settings) {
  const createRelease = operation("createRelease", "POST /v1/releases", s, async (ctx) => {
    const body = await readJsonObject(ctx.request);
    const title = textField(body.title, "title", 1, 200);
    const releaseDate = dateField(body.releaseDate, "releaseDate");
    const tracks = arrayField(body.tracks, "tracks", 1, 100).map((t, i) =>
      textField(objectField(t, `tracks[${i}]`).title, `tracks[${i}].title`, 1, 200),
    );
    const id = await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, ["artist"]);
      const [created] = await tx.query<{ id: string }>(
        `insert into public.api_releases (owner_id, title, release_date)
         values ($1::uuid, $2::text, $3::date) returning id::text as id`,
        [who.userId, title, releaseDate],
      );
      // One statement for every track, in order.
      await tx.query(
        `insert into public.api_tracks (release_id, position, title)
         select $1::uuid, t.ordinality::integer, t.value
           from jsonb_array_elements_text($2::jsonb) with ordinality as t`,
        [created.id, JSON.stringify(tracks)],
      );
      return created.id;
    });
    return json(201, await mustRead(ctx.modules.database, id), ctx.requestId);
  });

  const getRelease = operation("getRelease", "GET /v1/releases/{releaseId}", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const who = await whoIsCalling(ctx);
    allow(who, ["artist", ...STAFF_READERS]);
    const db = ctx.modules.database;
    if (who.type === "artist") await ownRelease(db, who, releaseId);
    return json(200, await mustRead(db, releaseId), ctx.requestId);
  });

  const getPublicRelease = operation("getPublicRelease", "GET /v1/public/releases/{releaseId}", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    await whoIsCalling(ctx);
    const db = ctx.modules.database;
    const rows = await db.query<{ id: string; artist_id: string; title: string; release_date: string; has_cover: boolean }>(
      `select r.id::text as id, r.artist_id::text as artist_id, r.title, ${day("r.release_date")} as release_date,
              exists (select 1 from public.api_covers c where c.release_id = r.id) as has_cover
         from public.api_releases r where r.id = $1::uuid and r.state = 'live'`,
      [releaseId],
    );
    const r = rows[0];
    // Anything not live is hidden: the same 404 as a release that does not exist.
    if (!r) throw notFound("No such release.");
    const tracks = await db.query<{ id: string; position: number; title: string }>(
      "select t.id::text as id, t.position, t.title from public.api_tracks t where t.release_id = $1::uuid order by t.position, t.id",
      [releaseId],
    );
    return json(
      200,
      { id: r.id, artistId: r.artist_id, title: r.title, releaseDate: r.release_date, hasCover: r.has_cover, tracks },
      ctx.requestId,
    );
  });

  const updateRelease = operation("updateRelease", "PATCH /v1/releases/{releaseId}", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const body = await readJsonObject(ctx.request);
    const known = ["title", "releaseDate", "tracks"].filter((k) => body[k] !== undefined);
    if (known.length === 0) throw badRequest("Send at least one of title, releaseDate and tracks.");
    const title = body.title === undefined ? null : textField(body.title, "title", 1, 200);
    const releaseDate = body.releaseDate === undefined ? null : dateField(body.releaseDate, "releaseDate");
    const tracks =
      body.tracks === undefined
        ? null
        : arrayField(body.tracks, "tracks", 1, 100).map((t, i) => {
            const o = objectField(t, `tracks[${i}]`);
            return {
              id: uuidField(o.id, `tracks[${i}].id`),
              title: o.title === undefined ? null : textField(o.title, `tracks[${i}].title`, 1, 200),
            };
          });

    await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, ["artist"]);
      const release = await ownRelease(tx, who, releaseId, true);
      if (!DETAILS_EDITABLE.includes(release.state)) {
        throw conflict("not_editable", `A release cannot be edited while ${release.state}.`);
      }
      if (tracks) {
        const current = await tx.query<{ id: string }>(
          "select t.id::text as id from public.api_tracks t where t.release_id = $1::uuid",
          [releaseId],
        );
        const have = new Set(current.map((t) => t.id));
        const sent = new Set(tracks.map((t) => t.id));
        if (sent.size !== tracks.length) throw unprocessable("bad_tracks", "tracks names a track more than once.");
        if (tracks.some((t) => !have.has(t.id))) throw unprocessable("bad_tracks", "tracks names a track that is not on this release.");
        if (sent.size !== have.size) throw unprocessable("bad_tracks", "tracks must list every track of the release.");
        // Positions are unique but deferred, so they can swap inside this transaction.
        await tx.query(
          `update public.api_tracks t
              set position = n.position, title = coalesce(n.title, t.title)
             from (select (e ->> 'id')::uuid as id, (e ->> 'title') as title, o::integer as position
                     from jsonb_array_elements($2::jsonb) with ordinality as x(e, o)) n
            where t.id = n.id and t.release_id = $1::uuid
              and (t.position <> n.position or (n.title is not null and t.title <> n.title))`,
          [releaseId, JSON.stringify(tracks)],
        );
      }
      if (title !== null || releaseDate !== null) {
        await tx.query(
          `update public.api_releases r
              set title = coalesce($2::text, r.title), release_date = coalesce($3::date, r.release_date)
            where r.id = $1::uuid
              and (r.title is distinct from coalesce($2::text, r.title)
                   or r.release_date is distinct from coalesce($3::date, r.release_date))`,
          [releaseId, title, releaseDate],
        );
      }
    });
    return json(200, await mustRead(ctx.modules.database, releaseId), ctx.requestId);
  });

  const listReleases = operation("listReleases", "GET /v1/releases", s, async (ctx) => {
    const query = new URL(ctx.request.url).searchParams;
    const stateText = query.get("state");
    const state = stateText === null ? null : enumField(stateText, "state", RELEASE_STATES);
    const limitText = query.get("limit");
    const limit = limitText === null ? 25 : integerField(/^\d{1,4}$/.test(limitText) ? Number(limitText) : NaN, "limit", 1, 100);
    const cursorText = query.get("cursor");
    const cursor = cursorText === null ? null : decodeCursor(stringField(cursorText, "cursor", 1, 512));

    const who = await whoIsCalling(ctx);
    allow(who, ["artist", ...STAFF_READERS]);
    const rows = await ctx.modules.database.query<{
      id: string;
      owner_id: string;
      title: string;
      release_date: string;
      state: ReleaseState;
      track_count: number;
      has_cover: boolean;
      created_at_cursor: string;
      updated_at: string;
    }>(
      `select l.id::text as id, l.owner_id::text as owner_id, l.title, ${day("l.release_date")} as release_date,
              l.state, l.track_count, l.has_cover, l.created_at::text as created_at_cursor, ${iso("l.updated_at")} as updated_at
         from public.api_list_releases($1::uuid, $2::text, $3::integer, $4::timestamptz, $5::uuid) l`,
      [who.userId, state, limit + 1, cursor?.createdAt ?? null, cursor?.id ?? null],
    );
    const page = rows.slice(0, limit);
    const body: Record<string, unknown> = {
      items: page.map((r) => ({
        id: r.id,
        owner_id: r.owner_id,
        title: r.title,
        releaseDate: r.release_date,
        state: r.state,
        trackCount: r.track_count,
        hasCover: r.has_cover,
        updatedAt: r.updated_at,
      })),
    };
    if (rows.length > limit) {
      const last = page[page.length - 1];
      body.nextCursor = encodeCursor(last.created_at_cursor, last.id);
    }
    return json(200, body, ctx.requestId);
  });

  const submitRelease = operation("submitRelease", "POST /v1/releases/{releaseId}/submit", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, ["artist"]);
      const release = await ownRelease(tx, who, releaseId, true);
      if (release.state !== "awaiting_splits") {
        throw conflict("wrong_state", `A release can be submitted only while awaiting_splits, not ${release.state}.`);
      }
      // Session B's trigger checks masters, track order, shares at 100 and no declined party
      // (422), and clears any earlier review decision.
      await tx.query("update public.api_releases set state = 'awaiting_review' where id = $1::uuid", [releaseId]);
    });
    return json(200, await mustRead(ctx.modules.database, releaseId), ctx.requestId);
  });

  const reviewRelease = operation("reviewRelease", "POST /v1/releases/{releaseId}/review", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const body = await readJsonObject(ctx.request);
    const decision = enumField(body.decision, "decision", ["approve", "needs_changes"] as const);
    let reason: string | null = null;
    if (body.reason !== undefined && body.reason !== null) reason = stringField(body.reason, "reason", 0, 2000);
    if (decision === "needs_changes") {
      if (!reason || reason.trim().length === 0) {
        throw badRequest("A needs_changes decision needs a reason.", { field: "reason" });
      }
    }
    const row = await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, STAFF_READERS);
      // Session B: staff only, never the owner (403), only while awaiting_review (409).
      await tx.query("select * from public.api_record_review($1::uuid, $2::uuid, $3::text, $4::text)", [
        releaseId,
        who.userId,
        decision,
        decision === "needs_changes" ? reason : null,
      ]);
      return releaseRow(tx, releaseId);
    });
    if (decision === "needs_changes" && row) {
      await emailOwner(ctx.modules, ctx.settings.log, releaseId, "review_needs_changes", {
        releaseTitle: row.title,
        reason: (reason ?? "").trim(),
      });
    }
    return json(200, await mustRead(ctx.modules.database, releaseId), ctx.requestId);
  });

  const publishRelease = operation("publishRelease", "POST /v1/releases/{releaseId}/publish", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, ["artist"]);
      await ownRelease(tx, who, releaseId, true);
      const [published] = await tx.query<{ release_state: ReleaseState; release_date: string }>(
        `select p.release_state, ${day("p.release_date")} as release_date from public.api_publish_release($1::uuid) p`,
        [releaseId],
      );
      if (published.release_state === "scheduled") {
        // Set inside the transaction: if the schedule cannot be set, the release stays
        // awaiting_review. A schedule left behind by a failed commit does nothing, because
        // api_release_go_live moves only a scheduled release.
        await ctx.modules.schedules.runSqlFunctionAt({
          name: `go-live:${releaseId}`,
          fn: "api_release_go_live",
          args: { p_release_id: releaseId },
          at: new Date(`${published.release_date}T00:00:00.000Z`),
        });
      }
    });
    return json(200, await mustRead(ctx.modules.database, releaseId), ctx.requestId);
  });

  const takedownRelease = operation("takedownRelease", "POST /v1/releases/{releaseId}/takedown", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const body = await readJsonObject(ctx.request);
    const reason = stringField(body.reason, "reason", 1, 2000);
    if (reason.trim().length === 0) throw badRequest("reason cannot be blank.", { field: "reason" });

    // The database part first: the audit row, streaming keys and cover cleared, open uploads
    // cancelled, the release taken_down. Listeners lose access when this commits.
    const done = await ctx.modules.database.transaction(async (tx) => {
      const who = await whoIsCalling(ctx, tx);
      allow(who, ["administrator"]);
      const [row] = await tx.query<{ audit_id: string; prefixes: string }>(
        "select t.audit_id::text as audit_id, t.prefixes::text as prefixes from public.api_takedown_release($1::uuid, $2::uuid, $3::text) t",
        [releaseId, who.userId, reason],
      );
      const release = await releaseRow(tx, releaseId);
      return { auditId: row.audit_id, prefixes: JSON.parse(row.prefixes) as string[], title: release?.title ?? "" };
    });

    // Then the files. A failure leaves files_deleted_at empty on the audit row and is logged;
    // the release stays taken down either way.
    await deletePrefixes(ctx, done.auditId, done.prefixes);
    await emailOwner(ctx.modules, ctx.settings.log, releaseId, "release_taken_down", {
      releaseTitle: done.title,
      reason: reason.trim(),
    });
    return json(200, { release: await mustRead(ctx.modules.database, releaseId), auditId: done.auditId }, ctx.requestId);
  });

  return {
    createRelease,
    getRelease,
    getPublicRelease,
    updateRelease,
    listReleases,
    submitRelease,
    reviewRelease,
    publishRelease,
    takedownRelease,
  };
}

async function deletePrefixes(ctx: Context, auditId: string, prefixes: string[]): Promise<void> {
  try {
    for (const prefix of prefixes) await ctx.modules.storage.delete(prefix);
    await ctx.modules.database.query("select public.api_takedown_files_deleted($1::uuid)", [auditId]);
  } catch (error) {
    ctx.settings.log(
      `takedown ${auditId}: deleting the files failed, files_deleted_at stays empty: ${(error as Error)?.message ?? String(error)}`,
    );
  }
}

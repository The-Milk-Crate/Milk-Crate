// getPlayback, getCover and recordPlays.
import type { ReleaseState } from "../platform/index.ts";
import { operation, STAFF_READERS, whoIsCalling, type Settings, type Who } from "./context.ts";
import { badRequest, conflict, json, notFound, tooMany } from "./http.ts";
import {
  arrayField,
  dateTimeField,
  enumField,
  integerField,
  objectField,
  pathUuid,
  readJsonObject,
  uuidField,
} from "./validate.ts";

/**
 * May this caller read a release's media in this state? The owner, administrator and internal
 * in any state; everyone else only when live. Nobody when taken down: the files are gone.
 * A removed or suspended staff role, or a suspended owner, reads as end_user.
 */
function mayReadMedia(who: Who, ownerId: string, state: ReleaseState): boolean {
  if (state === "taken_down") return false;
  if (state === "live") return true;
  if (STAFF_READERS.includes(who.type)) return true;
  return who.type === "artist" && who.userId === ownerId;
}

export function playbackOperations(s: Settings) {
  const getPlayback = operation("getPlayback", "GET /v1/tracks/{trackId}/playback", s, async (ctx) => {
    const trackId = pathUuid(ctx.params.trackId, "trackId");
    const who = await whoIsCalling(ctx);
    const rows = await ctx.modules.database.query<{ stream_key: string | null; owner_id: string; state: ReleaseState }>(
      `select t.stream_key, r.owner_id::text as owner_id, r.state
         from public.api_tracks t join public.api_releases r on r.id = t.release_id
        where t.id = $1::uuid`,
      [trackId],
    );
    const track = rows[0];
    if (!track || !mayReadMedia(who, track.owner_id, track.state)) throw notFound("No such track.");
    // Session B's stream_key is always under streams/{artist}/{release}/{track}/; a master is
    // never signed. None yet means processing has not made the streaming copy.
    if (!track.stream_key) throw notFound("This track has no streaming copy yet.");
    const grant = await ctx.modules.storage.signRead({ key: track.stream_key, userId: who.userId });
    return json(200, { ...grant, trackId }, ctx.requestId);
  });

  const getCover = operation("getCover", "GET /v1/releases/{releaseId}/cover", s, async (ctx) => {
    const releaseId = pathUuid(ctx.params.releaseId, "releaseId");
    const who = await whoIsCalling(ctx);
    const rows = await ctx.modules.database.query<{ object_key: string | null; owner_id: string; state: ReleaseState }>(
      `select c.object_key, r.owner_id::text as owner_id, r.state
         from public.api_releases r left join public.api_covers c on c.release_id = r.id
        where r.id = $1::uuid`,
      [releaseId],
    );
    const release = rows[0];
    if (!release || !mayReadMedia(who, release.owner_id, release.state)) throw notFound("No such release.");
    if (!release.object_key) throw notFound("This release has no cover.");
    const grant = await ctx.modules.storage.signRead({ key: release.object_key, userId: who.userId });
    return json(200, { ...grant, releaseId }, ctx.requestId);
  });

  const recordPlays = operation("recordPlays", "POST /v1/plays", s, async (ctx) => {
    const key = ctx.request.headers.get("idempotency-key");
    if (key === null || key.length < 8 || key.length > 128) {
      throw badRequest("Send an Idempotency-Key header of 8 to 128 characters.", { field: "Idempotency-Key" });
    }
    const body = await readJsonObject(ctx.request);
    // Only the contract's fields, in one order, so a retry of the same batch hashes the same.
    const events = arrayField(body.events, "events", 1, 100).map((item, i) => {
      const e = objectField(item, `events[${i}]`);
      return {
        type: enumField(e.type, `events[${i}].type`, ["start", "progress", "end"] as const),
        trackId: uuidField(e.trackId, `events[${i}].trackId`),
        playId: uuidField(e.playId, `events[${i}].playId`),
        // Session B stores at most 12 digits.
        positionMs: integerField(e.positionMs, `events[${i}].positionMs`, 0, 999_999_999_999),
        occurredAt: dateTimeField(e.occurredAt, `events[${i}].occurredAt`),
      };
    });
    const who = await whoIsCalling(ctx);
    // Session B's rule decides what qualifies (finding H1, session J1): 30 seconds of position
    // and device time, at least 15 seconds of server receive time, no position past the track's
    // length, no overlap with another counted play by this account, on a live release. Events
    // that do not qualify are kept; an unknown track is 422. The same statement counts the
    // limits: 60 batches a minute and 10,000 stored events a UTC day per account.
    const receivedAt = ctx.settings.playsReceivedAt ? ctx.settings.playsReceivedAt().toISOString() : null;
    const [row] = await ctx.modules.database.query<{
      status: "ok" | "duplicate" | "conflict" | "too_many_batches" | "too_many_events";
      retry_after: string | null;
    }>(
      `select b.status, b.retry_after_seconds::text as retry_after
         from public.api_record_play_batch($1::uuid, $2::text, $3::jsonb, $4::timestamptz) b`,
      [who.userId, key, JSON.stringify(events), receivedAt],
    );
    if (row.status === "too_many_batches") {
      throw tooMany("rate_limited", "Too many play batches from this account this minute. Send them again shortly.", Number(row.retry_after));
    }
    if (row.status === "too_many_events") {
      throw tooMany("rate_limited", "This account sent too many play events today. Try again tomorrow (UTC).", Number(row.retry_after));
    }
    if (row.status === "conflict") {
      throw conflict("idempotency_conflict", "This Idempotency-Key was already used for a different batch.");
    }
    return json(202, { duplicate: row.status === "duplicate" }, ctx.requestId);
  });

  return { getPlayback, getCover, recordPlays };
}

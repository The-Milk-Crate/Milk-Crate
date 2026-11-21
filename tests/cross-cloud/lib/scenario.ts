// The one scenario, run on each module set and by run-live.ts against a real deployment. It
// follows the whole slice (the brief's steps 1 to 9), then the refused cases. Every call is
// recorded (observe.ts); facts are extra checks whose values must match across sides.
//
// A Target is what the scenario needs from a deployment. The mocks give everything; a real
// deployment gives only the API, tokens and a way to wait, and the steps that need more (an
// invite code from an email, firing a schedule, a database read, a suspended account) are
// recorded as skipped there, never guessed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountType } from "../../../core/src/platform/index.ts";
import { loadContract } from "./contract.ts";
import { confirmBody, readGrant, sendFile, sha256Hex, type Api, type SentParts } from "./client.ts";
import { Recorder, type Actor } from "./observe.ts";

export interface Target {
  /** "supabase" or "aws" for the mocks; "live" for a real deployment. */
  side: string;
  api: Api;
  /** What upload endpoints and read grants are reached with. */
  uploadFetch: typeof fetch;
  actors: {
    artist: Actor;
    /** A second artist. Optional on a real deployment: the steps that need one are skipped. */
    otherArtist?: Actor;
    listener: Actor;
    thirdParty: Actor;
    admin: Actor;
    internal: Actor;
    accounting: Actor;
  };
  /** The release's state, read as staff or from the database. */
  stateOf(releaseId: string): Promise<string | undefined>;
  /** Returns when the release has left `processing` (runs the worker on the mocks). */
  processing(releaseId: string): Promise<void>;
  /** Where each invitation goes. */
  inviteeEmail(n: number): string;
  // The rest only on the mocks.
  inviteCode?: (email: string) => string | undefined;
  emailSubjects?: (email: string) => string[];
  fireSchedule?: (name: string) => Promise<void>;
  scheduledAt?: (name: string) => Promise<string | null>;
  storageKeys?: (prefix: string) => string[];
  auditRow?: (auditId: string) => Promise<{ reason: string; removed: unknown } | undefined>;
  /** Runs the hourly sweep's late pass for this takedown (at least 2 hours on); true when it is marked done. */
  lateTakedownPass?: (auditId: string) => Promise<boolean>;
  plays?: (playId: string) => Promise<{ events: number; qualified: number }>;
  /** Accounts a real deployment's tokens cannot stand for. */
  accounts?: {
    /** A suspended artist: `token` says end_user (after the refresh), `staleToken` still says artist. */
    suspendedArtist(): Promise<Actor & { staleToken: string }>;
    /** An administrator whose api_accounts row is removed; the token still says administrator. */
    removedAdmin(): Promise<Actor>;
  };
  log?: (line: string) => void;
}

// ---------- files, made with ffmpeg at run time (nothing binary is committed) ----------

function ffmpeg(args: string[], ext: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "mc-xc-"));
  try {
    const file = join(dir, `out.${ext}`);
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args, file]);
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A 16-bit stereo 44.1 kHz WAV tone. 50 seconds is about 8.4 MiB: two parts on S3. */
export function wav(seconds: number, frequency = 440): Uint8Array {
  return ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=44100`, "-t", String(seconds), "-ac", "2"], "wav");
}

/** A PNG of this size (one colour). */
export function png(width: number, height: number): Uint8Array {
  return ffmpeg(["-f", "lavfi", "-i", `color=c=0x336699:s=${width}x${height}`, "-frames:v", "1"], "png");
}

/** Not only ASCII, so each database path is checked to keep text exactly. */
const TITLE = "Cross-cloud one: Café “Ünïcode” 🎵 – \\ ' %";
const utcDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const uuidLike = () => crypto.randomUUID();

/** Masters and covers, made once per process and shared by every run. */
let media: { long: Uint8Array; short: Uint8Array; other: Uint8Array; cover: Uint8Array; tall: Uint8Array } | undefined;
export function scenarioMedia() {
  media ??= { long: wav(50), short: wav(2, 660), other: wav(3, 550), cover: png(1400, 1400), tall: png(1400, 1500) };
  return media;
}

export interface ScenarioResult {
  run: Recorder;
  ids: Record<string, string>;
}

/** The whole scenario on one target. */
export async function runScenario(t: Target): Promise<ScenarioResult> {
  const rec = new Recorder(t.side, t.api, (id) => t.stateOf(id));
  const log = t.log ?? (() => {});
  const { artist: A, otherArtist: B, listener: L, thirdParty: T, admin: X, internal: I, accounting: Q } = t.actors;
  const files = scenarioMedia();
  const ids: Record<string, string> = {};
  const has = (cap: unknown, step: string, why: string): boolean => {
    if (cap) return true;
    rec.skip(step, why);
    return false;
  };

  // ---- 1. A draft release with two tracks (and one for another artist) ----
  log("1. create releases");
  const created = await rec.call("1 create the release", "createRelease", A, {
    body: { title: TITLE, releaseDate: utcDay(1), tracks: [{ title: "First song" }, { title: "Second song" }] },
  }, 201);
  rec.fact("1 create the release", "the title comes back exactly as sent", created.body.title === TITLE);
  const r1 = created.body.id as string;
  const [t1, t2] = (created.body.tracks as { id: string }[]).map((x) => x.id);
  ids.r1 = r1;
  let rB: string | undefined;
  if (B) {
    const other = await rec.call("1 another artist creates a release", "createRelease", B, {
      body: { title: "Someone else's", releaseDate: utcDay(0), tracks: [{ title: "Theirs" }] },
    }, 201);
    rB = other.body.id;
  } else {
    rec.skip("1 another artist creates a release", "no second artist token");
  }

  // ---- 2. Masters: start both, interrupt one, resume it, confirm both ----
  log("2. upload masters");
  const s1 = await rec.call("2 start the upload of track 1", "startUpload", A, {
    params: { releaseId: r1, trackId: t1 }, body: { format: "wav", sizeBytes: files.long.length },
  }, 201, { release: r1 });
  const s2 = await rec.call("2 start the upload of track 2", "startUpload", A, {
    params: { releaseId: r1, trackId: t2 }, body: { format: "wav", sizeBytes: files.short.length },
  }, 201, { release: r1 });
  const method = s1.body.method as string;
  const half = Math.floor(files.long.length / 2);
  // Interrupted: tus stops half way, s3_multipart after its first part.
  let sent1: SentParts = await sendFile(t.api, A.token, t.uploadFetch, s1.body, files.long, new Map(), { stopAfter: { bytes: half, parts: 1 } });
  await rec.call("2 confirm track 1 before it is all there", "confirmUpload", A, {
    params: { uploadId: s1.body.uploadId }, body: await confirmBody(method, files.long, sent1),
  }, 422, { release: r1 });
  const resumed = await rec.call("2 read the interrupted upload", "getUpload", A, { params: { uploadId: s1.body.uploadId } }, 200);
  rec.fact("2 read the interrupted upload", "resumes from where it stopped",
    method === "tus"
      ? resumed.body.offset === half
      : JSON.stringify(resumed.body.completedParts?.map((p: { partNumber: number }) => p.partNumber)) === "[1]" && resumed.body.partCount === 2);
  await rec.call("2 more part URLs (s3_multipart only)", "signUploadParts", A, {
    params: { uploadId: s1.body.uploadId }, body: { partNumbers: [2] },
  }, method === "s3_multipart" ? 200 : 409, { branchDependent: true });
  sent1 = await sendFile(t.api, A.token, t.uploadFetch, resumed.body, files.long, sent1);
  const sent2 = await sendFile(t.api, A.token, t.uploadFetch, s2.body, files.short);
  await rec.call("2 confirm with no SHA-256", "confirmUpload", A, { params: { uploadId: s1.body.uploadId }, body: {} }, 400, { release: r1 });
  await rec.call("2 confirm track 1", "confirmUpload", A, {
    params: { uploadId: s1.body.uploadId }, body: await confirmBody(method, files.long, sent1),
  }, 200, { release: r1 });
  await rec.call("2 confirm track 1 again", "confirmUpload", A, {
    params: { uploadId: s1.body.uploadId }, body: await confirmBody(method, files.long, sent1),
  }, 409, { release: r1 });
  const lastConfirm = await rec.call("2 confirm track 2 (the last)", "confirmUpload", A, {
    params: { uploadId: s2.body.uploadId }, body: await confirmBody(method, files.short, sent2),
  }, 200, { release: r1 });
  rec.fact("2 confirm track 2 (the last)", "releaseState", lastConfirm.body.releaseState);

  // ---- 3. Processing succeeds ----
  log("3. processing");
  let before = await t.stateOf(r1);
  await t.processing(r1);
  rec.move("worker success", before, await t.stateOf(r1));
  const afterProcessing = await rec.call("3 the release after processing", "getRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  rec.fact("3 the release after processing", "every master confirmed", afterProcessing.body.tracks.every((x: { masterConfirmed: boolean }) => x.masterConfirmed));

  // ---- 3b. Edits, cover, list ----
  log("3b. edits and cover");
  const edited = await rec.call("3b edit the title and track order", "updateRelease", A, {
    params: { releaseId: r1 }, body: { title: "Cross-cloud one (edited)", tracks: [{ id: t2, title: "Second song, now first" }, { id: t1 }] },
  }, 200, { release: r1 });
  rec.fact("3b edit the title and track order", "new order", edited.body.tracks?.map((x: { id: string; position: number }) => `${x.position}:${x.id === t2 ? "t2" : "t1"}`));
  await rec.call("3b a track list that misses a track", "updateRelease", A, {
    params: { releaseId: r1 }, body: { tracks: [{ id: t1 }] },
  }, 422, { release: r1 });
  const tall = await rec.call("3b start a non-square cover", "startCoverUpload", A, {
    params: { releaseId: r1 }, body: { format: "png", sizeBytes: files.tall.length },
  }, 201, { release: r1 });
  const tallSent = await sendFile(t.api, A.token, t.uploadFetch, tall.body, files.tall);
  await rec.call("3b confirm the non-square cover", "confirmUpload", A, {
    params: { uploadId: tall.body.uploadId }, body: await confirmBody(tall.body.method, files.tall, tallSent),
  }, 422, { release: r1 });
  const cover = await rec.call("3b start a square cover", "startCoverUpload", A, {
    params: { releaseId: r1 }, body: { format: "png", sizeBytes: files.cover.length },
  }, 201, { release: r1 });
  const coverSent = await sendFile(t.api, A.token, t.uploadFetch, cover.body, files.cover);
  await rec.call("3b confirm the square cover", "confirmUpload", A, {
    params: { uploadId: cover.body.uploadId }, body: await confirmBody(cover.body.method, files.cover, coverSent),
  }, 200, { release: r1 });
  const listOwn = await rec.call("3b the artist lists their releases", "listReleases", A, {}, 200);
  rec.fact("3b the artist lists their releases", "sees their own, not the other artist's", {
    own: listOwn.body.items.some((x: { id: string }) => x.id === r1),
    other: rB ? listOwn.body.items.some((x: { id: string }) => x.id === rB) : "no second artist",
    allTheirs: listOwn.body.items.every((x: { owner_id: string }) => x.owner_id === created.body.owner_id),
  });

  // ---- 4. Rights and splits; invitations ----
  log("4. rights and invitations");
  const rights = await rec.call("4 add rights and splits", "putRights", A, {
    params: { releaseId: r1 },
    body: {
      parties: [
        { side: "recording", role: "artist", name: "The artist", percent: 50 },
        { side: "recording", role: "producer", name: "Invitee one", email: t.inviteeEmail(1), percent: 50 },
        { side: "composition", role: "songwriter", name: "The artist", percent: 40 },
        { side: "composition", role: "songwriter", name: "Invitee two", email: t.inviteeEmail(2), percent: 40 },
        { side: "composition", role: "publisher", name: "Invitee three", email: t.inviteeEmail(3), percent: 20 },
      ],
    },
  }, 200, { release: r1 });
  const parties = rights.body.parties as { id: string; email?: string; state: string }[];
  rec.fact("4 add rights and splits", "party states", parties.map((p) => p.state));
  rec.fact("4 add rights and splits", "parties come back in the order sent",
    JSON.stringify(parties.map((p) => p.email ?? null)) === JSON.stringify([null, t.inviteeEmail(1), null, t.inviteeEmail(2), t.inviteeEmail(3)]));
  const partyOf = (n: number) => parties.find((p) => p.email === t.inviteeEmail(n))!.id;

  const code = (n: number) => t.inviteCode?.(t.inviteeEmail(n));
  const invitationKeys = (body: unknown) => JSON.stringify(Object.keys(body as object).sort());
  const wantInvitationKeys = JSON.stringify(["artistName", "party", "releaseDate", "releaseTitle", "trackTitles"]);
  const invitees: [number, Actor | undefined][] = [[1, L], [2, T], [3, B]];
  if (has(t.inviteCode, "4 invitees view and accept", "the invite codes are only in the emails")) {
    for (const [n, who] of invitees) {
      if (!who) {
        rec.skip(`4 invitee ${n} views the invitation`, "no second artist token");
        continue;
      }
      const viewed = await rec.call(`4 invitee ${n} (${who.type}) views the invitation`, "getInvitation", who, {
        params: { releaseId: r1, partyId: partyOf(n) }, body: { inviteCode: code(n) },
      }, 200, { release: r1 });
      rec.fact(`4 invitee ${n} views the invitation`, "only the release basics and their own share",
        invitationKeys(viewed.body) === wantInvitationKeys &&
          !JSON.stringify(viewed.body).includes("@") &&
          !JSON.stringify(viewed.body).includes(created.body.owner_id) &&
          JSON.stringify(Object.keys(viewed.body.party).sort()) === JSON.stringify(["percent", "role", "side", "state"]));
      if (n === 2) {
        await rec.call("4 a staff account views an invitation", "getInvitation", X, {
          params: { releaseId: r1, partyId: partyOf(n) }, body: { inviteCode: code(n) },
        }, 403);
        await rec.call("4 a staff account replies to an invitation", "respondToSplit", I, {
          params: { releaseId: r1, partyId: partyOf(n) }, body: { response: "accept", inviteCode: code(n) },
        }, 403);
        await rec.call("4 a wrong code on the view", "getInvitation", who, {
          params: { releaseId: r1, partyId: partyOf(n) }, body: { inviteCode: "wrong-code-0123456789" },
        }, 403);
        await rec.call("4 a wrong code on the reply", "respondToSplit", who, {
          params: { releaseId: r1, partyId: partyOf(n) }, body: { response: "accept", inviteCode: "wrong-code-0123456789" },
        }, 403);
      }
      const replied = await rec.call(`4 invitee ${n} (${who.type}) accepts`, "respondToSplit", who, {
        params: { releaseId: r1, partyId: partyOf(n) }, body: { response: "accept", inviteCode: code(n) },
      }, 200, { release: r1 });
      rec.fact(`4 invitee ${n} accepts`, "sees only their own party", replied.body.parties?.length === 1 && replied.body.parties[0].state === "accepted");
      if (n === 1) {
        await rec.call("4 a used code on the view", "getInvitation", who, {
          params: { releaseId: r1, partyId: partyOf(n) }, body: { inviteCode: code(n) },
        }, 409);
        await rec.call("4 a used code on the reply", "respondToSplit", who, {
          params: { releaseId: r1, partyId: partyOf(n) }, body: { response: "decline", inviteCode: code(n) },
        }, 409);
      }
    }
  }
  await rec.call("4 resend to a party that replied", "resendInvitation", A, { params: { releaseId: r1, partyId: partyOf(1) } }, t.inviteCode ? 409 : 204);

  // ---- 4b. A second release fails processing, and the master is replaced ----
  log("4b. a failed release");
  const second = await rec.call("4b create a second release", "createRelease", A, {
    body: { title: "Cross-cloud two", releaseDate: utcDay(0), tracks: [{ title: "Only song" }] },
  }, 201);
  const r2 = second.body.id as string;
  const r2t = second.body.tracks[0].id as string;
  ids.r2 = r2;
  const bad = await rec.call("4b start its upload", "startUpload", A, {
    params: { releaseId: r2, trackId: r2t }, body: { format: "wav", sizeBytes: files.other.length },
  }, 201, { release: r2 });
  const badSent = await sendFile(t.api, A.token, t.uploadFetch, bad.body, files.other);
  // The client sends a SHA-256 that is not the file's: processing checks it and fails.
  await rec.call("4b confirm with a SHA-256 that does not match", "confirmUpload", A, {
    params: { uploadId: bad.body.uploadId }, body: await confirmBody(bad.body.method, files.other, badSent, "0".repeat(64)),
  }, 200, { release: r2 });
  before = await t.stateOf(r2);
  await t.processing(r2);
  rec.move("worker error", before, await t.stateOf(r2));
  const failed = await rec.call("4b the failed release", "getRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  rec.fact("4b the failed release", "has a plain reason", typeof failed.body.failureReason === "string" && /checksum/i.test(failed.body.failureReason));
  const again = await rec.call("4b replace the master", "startUpload", A, {
    params: { releaseId: r2, trackId: r2t }, body: { format: "wav", sizeBytes: files.other.length },
  }, 201, { release: r2 });
  const replaced = await rec.call("4b the release after the replace starts", "getRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  rec.fact("4b the release after the replace starts", "failureReason cleared", replaced.body.failureReason === undefined);
  const againSent = await sendFile(t.api, A.token, t.uploadFetch, again.body, files.other);
  await rec.call("4b confirm the new master", "confirmUpload", A, {
    params: { uploadId: again.body.uploadId }, body: await confirmBody(again.body.method, files.other, againSent),
  }, 200, { release: r2 });
  before = await t.stateOf(r2);
  await t.processing(r2);
  rec.move("worker success", before, await t.stateOf(r2));
  await rec.call("4b the second release after processing", "getRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  const r2cover = await rec.call("4b a cover for the second release", "startCoverUpload", A, {
    params: { releaseId: r2 }, body: { format: "png", sizeBytes: files.cover.length },
  }, 201, { release: r2 });
  const r2coverSent = await sendFile(t.api, A.token, t.uploadFetch, r2cover.body, files.cover);
  await rec.call("4b confirm the second release's cover", "confirmUpload", A, {
    params: { uploadId: r2cover.body.uploadId }, body: await confirmBody(r2cover.body.method, files.cover, r2coverSent),
  }, 200, { release: r2 });

  // Invitation limits, on the second release: too many wrong codes (counted across the view
  // and the reply), and the daily send limit.
  const r2rights = await rec.call("4b rights on the second release", "putRights", A, {
    params: { releaseId: r2 },
    body: {
      parties: [
        { side: "recording", role: "artist", name: "The artist", percent: 100 },
        { side: "composition", role: "songwriter", name: "The artist", percent: 50 },
        { side: "composition", role: "songwriter", name: "Invitee four", email: t.inviteeEmail(4), percent: 50 },
      ],
    },
  }, 200, { release: r2 });
  const p4 = (r2rights.body.parties as { id: string; email?: string }[]).find((p) => p.email === t.inviteeEmail(4))!.id;
  for (let i = 1; i <= 10; i++) {
    const op = i % 2 ? "getInvitation" : "respondToSplit";
    await rec.call(`4b wrong code ${i} of 10`, op, L, {
      params: { releaseId: r2, partyId: p4 },
      body: op === "getInvitation" ? { inviteCode: `wrong-code-${i}-0123456789` } : { response: "accept", inviteCode: `wrong-code-${i}-0123456789` },
    }, 403);
  }
  const limited = await rec.call("4b the 11th wrong code", "getInvitation", L, {
    params: { releaseId: r2, partyId: p4 }, body: { inviteCode: "wrong-code-11-0123456789" },
  }, 429);
  rec.fact("4b the 11th wrong code", "Retry-After is set", Number(limited.headers.get("retry-after")) > 0);
  if (has(t.inviteCode, "4b the right code while locked", "the invite codes are only in the emails")) {
    await rec.call("4b the right code while locked", "respondToSplit", L, {
      params: { releaseId: r2, partyId: p4 }, body: { response: "accept", inviteCode: t.inviteCode!(t.inviteeEmail(4)) },
    }, 429);
  }
  await rec.call("4b a listener cannot resend", "resendInvitation", L, { params: { releaseId: r2, partyId: p4 } }, 403);
  if (B) {
    await rec.call("4b another artist cannot resend", "resendInvitation", B, { params: { releaseId: r2, partyId: p4 } }, 404);
  }
  // putRights sent the first; four resends reach the limit of five a day.
  for (let i = 2; i <= 5; i++) {
    await rec.call(`4b resend ${i} of 5`, "resendInvitation", A, { params: { releaseId: r2, partyId: p4 } }, 204, { release: r2 });
  }
  await rec.call("4b resend 6 of 5", "resendInvitation", A, { params: { releaseId: r2, partyId: p4 } }, 429);
  if (t.emailSubjects) rec.fact("4b invitation emails", "five sent to invitee four", t.emailSubjects(t.inviteeEmail(4)).length);

  // ---- 5. Submit, needs changes, fix, resubmit, approve ----
  log("5. review");
  await rec.call("5 submit", "submitRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  await rec.call("5 submit again", "submitRelease", A, { params: { releaseId: r1 } }, 409, { release: r1 });
  await rec.call("5 edit while in review", "updateRelease", A, { params: { releaseId: r1 }, body: { title: "No" } }, 409, { release: r1 });
  await rec.call("5 a new master while in review", "startUpload", A, {
    params: { releaseId: r1, trackId: t1 }, body: { format: "wav", sizeBytes: 1000 },
  }, 409, { release: r1 });
  const queue = await rec.call("5 a reviewer lists the review queue", "listReleases", I, { query: { state: "awaiting_review", limit: "100" } }, 200);
  rec.fact("5 a reviewer lists the review queue", "sees it, and only awaiting_review",
    queue.body.items.some((x: { id: string }) => x.id === r1) && queue.body.items.every((x: { state: string }) => x.state === "awaiting_review"));
  await rec.call("5 an administrator lists every release", "listReleases", X, {}, 200);
  // Paging with the cursor (it carries a timestamp, read through each database path).
  const paged: string[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 5; page++) {
    const r = await rec.call(`5 the artist lists one release a page (page ${page})`, "listReleases", A, {
      query: { limit: "1", ...(cursor ? { cursor } : {}) },
    }, 200);
    paged.push(...r.body.items.map((x: { id: string }) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  rec.fact("5 the artist lists one release a page", "every release once, newest first", JSON.stringify(paged) === JSON.stringify([r2, r1]));
  await rec.call("5 a cursor that is not one", "listReleases", A, { query: { cursor: "not-a-cursor" } }, 400);
  await rec.call("5 publish before approval", "publishRelease", A, { params: { releaseId: r1 } }, 409, { release: r1 });
  await rec.call("5 needs changes with no reason", "reviewRelease", X, { params: { releaseId: r1 }, body: { decision: "needs_changes" } }, 400, { release: r1 });
  await rec.call("5 the artist cannot review", "reviewRelease", A, { params: { releaseId: r1 }, body: { decision: "approve" } }, 403, { release: r1 });
  await rec.call("5 internal accounting cannot review", "reviewRelease", Q, { params: { releaseId: r1 }, body: { decision: "approve" } }, 403, { release: r1 });
  await rec.call("5 a reviewer asks for changes", "reviewRelease", I, {
    params: { releaseId: r1 }, body: { decision: "needs_changes", reason: "Fix the second title." },
  }, 200, { release: r1 });
  if (t.emailSubjects) rec.fact("5 a reviewer asks for changes", "the owner is emailed", t.emailSubjects(A.email ?? "").length);
  await rec.call("5 the artist fixes the title", "updateRelease", A, {
    params: { releaseId: r1 }, body: { tracks: [{ id: t2, title: "Second song" }, { id: t1 }] },
  }, 200, { release: r1 });
  // The fix is a new master for track 2: needs_changes → uploading → processing → awaiting_splits.
  const fix = await rec.call("5 the artist replaces a master", "startUpload", A, {
    params: { releaseId: r1, trackId: t2 }, body: { format: "wav", sizeBytes: files.short.length },
  }, 201, { release: r1 });
  const fixSent = await sendFile(t.api, A.token, t.uploadFetch, fix.body, files.short);
  await rec.call("5 confirm the new master", "confirmUpload", A, {
    params: { uploadId: fix.body.uploadId }, body: await confirmBody(fix.body.method, files.short, fixSent),
  }, 200, { release: r1 });
  before = await t.stateOf(r1);
  await t.processing(r1);
  rec.move("worker success", before, await t.stateOf(r1));
  const current = await rec.call("5 the rights are kept", "getRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  // In the order sent (putRights writes each party's position).
  rec.fact("5 the rights are kept", "party states", current.body.rights?.parties?.map((p: { state: string }) => p.state));
  rec.fact("5 the rights are kept", "parties in the order sent",
    current.body.rights?.parties?.map((p: { id: string }) => p.id).join(",") === parties.map((p) => p.id).join(","));
  await rec.call("5 resubmit", "submitRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  const approved = await rec.call("5 a reviewer approves", "reviewRelease", X, { params: { releaseId: r1 }, body: { decision: "approve" } }, 200, { release: r1 });
  rec.fact("5 a reviewer approves", "decision", approved.body.review?.decision);

  // ---- 6. Publish with a future date; the schedule fires ----
  log("6. publish");
  await rec.call("6 publish with a future release date", "publishRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  const goLive = `go-live:${r1}`;
  if (has(t.fireSchedule, "6 the schedule fires", "a real schedule fires at 00:00 UTC on the release date")) {
    rec.fact("6 publish", "the go-live run is set for the release date", await t.scheduledAt!(goLive) === `${utcDay(1)}T00:00:00Z`);
    before = await t.stateOf(r1);
    await t.fireSchedule!(goLive);
    rec.move("schedule fires", before, await t.stateOf(r1));
    await rec.call("6 the release after the schedule fired", "getRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  }
  const live = (await t.stateOf(r1)) === "live";

  // ---- 7. Who sees what ----
  log("7. reads");
  if (B) {
    await rec.call("7 another artist reads the release", "getRelease", B, { params: { releaseId: r1 } }, 404);
    const theirs = await rec.call("7 another artist lists releases", "listReleases", B, {}, 200);
    rec.fact("7 another artist lists releases", "the release is left out", theirs.body.items.some((x: { id: string }) => x.id === r1));
  }
  await rec.call("7 an administrator reads the release", "getRelease", X, { params: { releaseId: r1 } }, 200);
  await rec.call("7 internal reads the release", "getRelease", I, { params: { releaseId: r1 } }, 200);
  if (live) {
    await rec.call("7 a listener reads the release once it is live", "getPublicRelease", L, { params: { releaseId: r1 } }, 200, { release: r1 });
    await rec.call("7 a listener gets playback once it is live", "getPlayback", L, { params: { trackId: t1 } }, 200);
  } else {
    rec.skip("7 a listener reads the first release once it is live", "it goes live only when its schedule fires");
  }
  await rec.call("7 a listener reads a release that is not live", "getPublicRelease", L, { params: { releaseId: r2 } }, 404);
  await rec.call("7 a listener gets playback of a track that is not live", "getPlayback", L, { params: { trackId: r2t } }, 404);
  await rec.call("7 a listener gets the cover of a release that is not live", "getCover", L, { params: { releaseId: r2 } }, 404);
  await rec.call("7 the owner gets playback before it is live", "getPlayback", A, { params: { trackId: r2t } }, 200);
  await rec.call("7 the owner gets the cover before it is live", "getCover", A, { params: { releaseId: r2 } }, 200);
  await rec.call("7 the owner asks for a cover that does not exist", "getCover", B ?? A, { params: { releaseId: rB ?? uuidLike() } }, 404);

  // The second release: changes asked, the rights saved again (needs_changes → awaiting_splits),
  // then published with today's date, so it goes live at once.
  await rec.call("7b submit the second release", "submitRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  await rec.call("7b a reviewer asks for changes to the second release", "reviewRelease", X, {
    params: { releaseId: r2 }, body: { decision: "needs_changes", reason: "Check the split." },
  }, 200, { release: r2 });
  const r2now = await rec.call("7b the artist reads the second release", "getRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  const keep = (r2now.body.rights.parties as Record<string, unknown>[]).map(({ state: _state, ...p }) => p);
  await rec.call("7b the artist saves the rights again", "putRights", A, { params: { releaseId: r2 }, body: { parties: keep } }, 200, { release: r2 });
  await rec.call("7b resubmit the second release", "submitRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  await rec.call("7b a reviewer approves the second release", "reviewRelease", I, { params: { releaseId: r2 }, body: { decision: "approve" } }, 200, { release: r2 });
  await rec.call("7b publish with today's date", "publishRelease", A, { params: { releaseId: r2 } }, 200, { release: r2 });
  // Every account type reads the live release, plays it and reads its cover.
  const every: Actor[] = [L, A, T, X, I, Q];
  for (const who of every) {
    const pub = await rec.call(`7b ${who.type} reads the public view`, "getPublicRelease", who, { params: { releaseId: r2 } }, 200, { release: r2 });
    if (who === L) {
      rec.fact("7b end_user reads the public view", "no owner_id, rights or review",
        JSON.stringify(Object.keys(pub.body).sort()) === JSON.stringify(["artistId", "hasCover", "id", "releaseDate", "title", "tracks"]));
    }
    const play = await rec.call(`7b ${who.type} gets playback`, "getPlayback", who, { params: { trackId: r2t } }, 200);
    const coverGrant = await rec.call(`7b ${who.type} gets the cover`, "getCover", who, { params: { releaseId: r2 } }, 200, { release: r2 });
    if (who === L) {
      const audio = await readGrant(t.uploadFetch, play.body);
      const bytes = new Uint8Array(await audio.arrayBuffer());
      rec.fact("7b end_user gets playback", "the grant reads an MP3 (the streaming copy, not the WAV master)",
        audio.status === 200 && (String.fromCharCode(...bytes.slice(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)));
      const image = await readGrant(t.uploadFetch, coverGrant.body);
      const imageBytes = new Uint8Array(await image.arrayBuffer());
      rec.fact("7b end_user gets the cover", "the grant reads the cover", image.status === 200 && (await sha256Hex(imageBytes)) === (await sha256Hex(files.cover)));
    }
  }

  // ---- 8. Play events ----
  log("8. plays");
  const long = uuidLike();
  const short = uuidLike();
  const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, s)).toISOString();
  const batch = {
    events: [
      { type: "start", trackId: r2t, playId: long, positionMs: 0, occurredAt: at(0) },
      { type: "progress", trackId: r2t, playId: long, positionMs: 15000, occurredAt: at(15) },
      { type: "end", trackId: r2t, playId: long, positionMs: 31000, occurredAt: at(31) },
      { type: "start", trackId: r2t, playId: short, positionMs: 0, occurredAt: at(40) },
      { type: "end", trackId: r2t, playId: short, positionMs: 12000, occurredAt: at(52) },
    ],
  };
  const key = `xc-${uuidLike()}`;
  const first = await rec.call("8 a batch of plays", "recordPlays", L, { headers: { "idempotency-key": key }, body: batch }, 202);
  rec.fact("8 a batch of plays", "duplicate", first.body?.duplicate);
  const dup = await rec.call("8 the same batch again", "recordPlays", L, { headers: { "idempotency-key": key }, body: batch }, 202);
  rec.fact("8 the same batch again", "duplicate", dup.body?.duplicate);
  if (has(t.plays, "8 counts", "play rows are not readable through the API")) {
    rec.fact("8 counts", "30 s or more qualifies, shorter does not, a repeat counts once", {
      long: await t.plays!(long),
      short: await t.plays!(short),
    });
  }
  await rec.call("8 the same key with another batch", "recordPlays", L, {
    headers: { "idempotency-key": key }, body: { events: [batch.events[0]] },
  }, 409);
  await rec.call("8 plays with no Idempotency-Key", "recordPlays", L, { body: batch }, 400);
  await rec.call("8 a play of a track that does not exist", "recordPlays", L, {
    headers: { "idempotency-key": `xc-${uuidLike()}` },
    body: { events: [{ ...batch.events[0], trackId: uuidLike() }] },
  }, 422);
  for (const who of every) {
    if (who === L) continue;
    await rec.call(`8 ${who.type} sends a play`, "recordPlays", who, {
      headers: { "idempotency-key": `xc-${uuidLike()}` },
      body: { events: [{ type: "start", trackId: r2t, playId: uuidLike(), positionMs: 0, occurredAt: at(0) }] },
    }, 202);
  }

  // ---- Refused cases ----
  log("refused cases");
  await refusedCases(rec, t, { r1, t1, r2, r2t, upload: s1.body.uploadId, party: partyOf(1) });

  // ---- 9. Takedown ----
  log("9. takedown");
  await rec.call("9 internal (not an administrator) takes it down", "takedownRelease", I, { params: { releaseId: r1 }, body: { reason: "No." } }, 403, { release: r1 });
  await rec.call("9 takedown with no reason", "takedownRelease", X, { params: { releaseId: r1 }, body: {} }, 400, { release: r1 });
  const down = await rec.call("9 an administrator takes it down", "takedownRelease", X, {
    params: { releaseId: r1 }, body: { reason: "Cross-cloud check: rights claim." },
  }, 200, { release: r1 });
  if (has(t.storageKeys, "9 the files are gone", "storage is not listed through the API")) {
    rec.fact("9 the files are gone", "masters, streams and art", {
      masters: t.storageKeys!("masters/").filter((k) => k.includes(r1)),
      streams: t.storageKeys!("streams/").filter((k) => k.includes(r1)),
      art: t.storageKeys!("art/").filter((k) => k.includes(r1)),
    });
  }
  if (has(t.auditRow, "9 the audit row", "the audit log is not readable through the API")) {
    const audit = await t.auditRow!(down.body.auditId);
    rec.fact("9 the audit row", "exists with the reason", audit?.reason);
    rec.fact("9 the audit row", "lists what was removed", audit?.removed);
  }
  if (t.emailSubjects) rec.fact("9 an administrator takes it down", "the owner is emailed", t.emailSubjects(A.email ?? "").length);
  await rec.call("9 take it down again", "takedownRelease", X, { params: { releaseId: r1 }, body: { reason: "Again." } }, 409, { release: r1 });
  await rec.call("9 a listener reads it after the takedown", "getPublicRelease", L, { params: { releaseId: r1 } }, 404);
  await rec.call("9 a listener gets playback after the takedown", "getPlayback", L, { params: { trackId: t1 } }, 404);
  await rec.call("9 the owner gets playback after the takedown", "getPlayback", A, { params: { trackId: t1 } }, 404);
  await rec.call("9 an administrator gets the cover after the takedown", "getCover", X, { params: { releaseId: r1 } }, 404);
  await rec.call("9 the owner still reads it", "getRelease", A, { params: { releaseId: r1 } }, 200, { release: r1 });
  if (has(t.inviteCode, "9 an invitation after the takedown", "the invite codes are only in the emails")) {
    await rec.call("9 an invitation after the takedown", "getInvitation", L, {
      params: { releaseId: r1, partyId: partyOf(1) }, body: { inviteCode: t.inviteCode!(t.inviteeEmail(1)) },
    }, 409);
  }
  await rec.call("9 the second release is taken down too", "takedownRelease", X, {
    params: { releaseId: r2 }, body: { reason: "Cross-cloud check: clean up." },
  }, 200, { release: r2 });
  if (rB && B) {
    // An upload still open when the release is taken down: the artist's app sends the rest
    // afterwards. Takedown deletes every file of the release, so nothing should be stored.
    const theirs = await rec.call("9 the other artist reads their release", "getRelease", B, { params: { releaseId: rB } }, 200, { release: rB });
    const open = await rec.call("9 the other artist starts an upload", "startUpload", B, {
      params: { releaseId: rB, trackId: theirs.body.tracks[0].id }, body: { format: "wav", sizeBytes: files.other.length },
    }, 201, { release: rB });
    const openSent = await sendFile(t.api, B.token, t.uploadFetch, open.body, files.other, new Map(), {
      stopAfter: { bytes: Math.floor(files.other.length / 2), parts: 0 },
    });
    const downB = await rec.call("9 the other artist's release is taken down", "takedownRelease", X, {
      params: { releaseId: rB }, body: { reason: "Cross-cloud check: clean up." },
    }, 200, { release: rB });
    // A cancelled upload gets no fresh session (on Supabase, no fresh upload token).
    await rec.call("9 read the upload after the takedown", "getUpload", B, { params: { uploadId: open.body.uploadId } }, 409);
    // The app sends the rest with the session it already holds. Supabase may still accept it
    // while that token lasts (up to 2 hours; decided by K Marcus, no interface change), AWS
    // refuses it. Not compared: what counts is that nothing is left after the late pass.
    // The app knows how far it got (tus: the bytes it sent; S3: the parts in openSent).
    const half = Math.floor(files.other.length / 2);
    const held = open.body.method === "tus" ? { ...open.body, offset: half } : open.body;
    let rest = "accepted";
    try {
      await sendFile(t.api, B.token, t.uploadFetch, held, files.other, openSent);
    } catch (error) {
      rest = "refused";
    }
    log(`9 the rest of the file, sent after the takedown, is ${rest} on ${t.side}`);
    await rec.call("9 confirm the upload after the takedown", "confirmUpload", B, {
      params: { uploadId: open.body.uploadId }, body: await confirmBody(open.body.method, files.other, openSent),
    }, 409, { release: rB });
    if (has(t.lateTakedownPass, "9 the sweep's late pass", "the sweep cannot be run, or the clock moved, through the API")) {
      rec.fact("9 the sweep's late pass", "marks the takedown done", await t.lateTakedownPass!(downB.body.auditId));
      if (t.storageKeys) {
        rec.fact("9 the sweep's late pass", "masters left for the taken-down release", t.storageKeys("masters/").filter((k) => k.includes(rB!)).length);
      }
    }
  }
  return { run: rec, ids };
}

/** A body each operation accepts, so a refused call is refused for who it is, not what it sent. */
function validInput(operationId: string, ids: { r1: string; t1: string; r2: string; r2t: string; upload: string; party: string }) {
  const p = { releaseId: ids.r1, trackId: ids.t1, uploadId: ids.upload, partyId: ids.party };
  const bodies: Record<string, unknown> = {
    createRelease: { title: "Refused", releaseDate: utcDay(0), tracks: [{ title: "x" }] },
    updateRelease: { title: "Refused" },
    startUpload: { format: "wav", sizeBytes: 1000 },
    startCoverUpload: { format: "png", sizeBytes: 1000 },
    signUploadParts: { partNumbers: [1] },
    confirmUpload: { sha256: "a".repeat(64) },
    putRights: { parties: [{ side: "recording", role: "artist", name: "x", percent: 100 }, { side: "composition", role: "artist", name: "x", percent: 100 }] },
    getInvitation: { inviteCode: "refused-0123456789abcdef" },
    respondToSplit: { response: "accept", inviteCode: "refused-0123456789abcdef" },
    reviewRelease: { decision: "approve" },
    takedownRelease: { reason: "Refused." },
    recordPlays: { events: [{ type: "start", trackId: ids.t1, playId: crypto.randomUUID(), positionMs: 0, occurredAt: new Date().toISOString() }] },
  };
  return {
    params: p,
    ...(operationId in bodies ? { body: bodies[operationId] } : {}),
    ...(operationId === "recordPlays" ? { headers: { "idempotency-key": `xc-${crypto.randomUUID()}` } } : {}),
  };
}

/**
 * Each account type calling each operation it may not call (403), no token on every operation
 * (401), a bad request, a suspended account, and a staff account whose row was removed.
 */
async function refusedCases(
  rec: Recorder,
  t: Target,
  ids: { r1: string; t1: string; r2: string; r2t: string; upload: string; party: string },
): Promise<void> {
  const contract = loadContract();
  const byType: Record<AccountType, Actor> = {
    end_user: t.actors.listener,
    artist: t.actors.artist,
    third_party: t.actors.thirdParty,
    administrator: t.actors.admin,
    internal: t.actors.internal,
    internal_accounting: t.actors.accounting,
  };
  for (const op of Object.values(contract.operations)) {
    await rec.call(`refused: ${op.operationId} with no token`, op.operationId, null, validInput(op.operationId, ids), 401);
    for (const type of contract.accountTypes as AccountType[]) {
      if (op.accountTypes.includes(type)) continue;
      await rec.call(`refused: ${op.operationId} as ${type}`, op.operationId, byType[type], validInput(op.operationId, ids), 403);
    }
  }
  const A = t.actors.artist;
  await rec.call("refused: a body that is not JSON", "createRelease", A, { rawBody: "{not json" }, 400);
  await rec.call("refused: a release with no title", "createRelease", A, { body: { title: "", releaseDate: utcDay(0), tracks: [{ title: "x" }] } }, 400);
  await rec.call("refused: a release id that is not a uuid", "getRelease", A, { params: { releaseId: "not-a-uuid" } }, 400);
  await rec.call("refused: rights that do not add up to 100", "putRights", A, {
    params: { releaseId: ids.r2 },
    body: { parties: [{ side: "recording", role: "artist", name: "x", percent: 60 }, { side: "composition", role: "artist", name: "x", percent: 100 }] },
  }, 422, { release: ids.r2 });
  await rec.call("refused: a token that is not valid", "listReleases", { label: "bad token", type: "artist", token: "e30.e30.c2ln" }, {}, 401);

  if (t.accounts) {
    const suspended = await t.accounts.suspendedArtist();
    await rec.call("refused: a suspended artist creates a release", "createRelease", suspended, validInput("createRelease", ids), 403);
    await rec.call("refused: a suspended artist with a token from before reads their list", "listReleases",
      { ...suspended, label: "suspended artist (old token)", type: "artist", token: suspended.staleToken, actsAs: "end_user" }, {}, 403);
    await rec.call("refused: a suspended artist reads the public view as a listener", "getPublicRelease", suspended, { params: { releaseId: ids.r1 } }, 200);
    const removed = await t.accounts.removedAdmin();
    await rec.call("refused: a removed administrator takes down", "takedownRelease", removed, validInput("takedownRelease", ids), 403, { release: ids.r1 });
    await rec.call("refused: a removed administrator reviews", "reviewRelease", removed, validInput("reviewRelease", ids), 403);
    await rec.call("refused: a removed administrator reads a release", "getRelease", removed, { params: { releaseId: ids.r2 } }, 403);
    await rec.call("refused: a removed administrator reads the public view as a listener", "getPublicRelease", removed, { params: { releaseId: ids.r1 } }, 200);
  } else {
    rec.skip("refused: suspended and removed accounts", "needs accounts a real deployment's tokens cannot stand for");
  }
}

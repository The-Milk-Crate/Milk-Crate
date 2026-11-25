import { randomUUID } from "node:crypto";
import type { AccountType, ReleaseState } from "../src/platform/index.ts";
import { makeOperations, type CoreOptions, type OperationId } from "../src/handlers/index.ts";
import { testDatabase, type TestDatabase } from "./pg.ts";
import { fakeModules, type FakeModules } from "./fakes.ts";

const url = process.env.MC_TEST_DB_URL;
if (!url) throw new Error("MC_TEST_DB_URL is not set: run bash core/test/run.sh");

export const db: TestDatabase = testDatabase(url);

/** A fixed clock and a counting random source, so runs repeat. */
export function testOptions(extra: CoreOptions = {}): CoreOptions & { logs: string[] } {
  const logs: string[] = [];
  let n = 0;
  let r = 0;
  return {
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    randomBytes: (length) => {
      r++;
      // Different every call, the same every run.
      return Uint8Array.from({ length }, (_, i) => (r * 31 + i * 7) & 0xff);
    },
    newRequestId: () => `req-${++n}`,
    log: (m) => logs.push(m),
    logs,
    ...extra,
  };
}

export interface Harness {
  modules: FakeModules;
  options: ReturnType<typeof testOptions>;
  ops: ReturnType<typeof makeOperations>;
  /**
   * The server receive time recordPlays records (CoreOptions.playsReceivedAt, test only). It
   * moves only when a test moves it, so a test can send a play's batches seconds apart.
   */
  playsAt: { time: Date };
  call(op: OperationId, input?: CallInput): Promise<{ status: number; body: any; headers: Headers }>;
}

export interface CallInput {
  as?: Account | { userId: string; type: AccountType } | null;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export function harness(method: "tus" | "s3_multipart" = "tus", extra: CoreOptions = {}): Harness {
  const modules = fakeModules(db, method);
  const playsAt = { time: new Date("2026-06-01T12:00:00.000Z") };
  const options = testOptions({ playsReceivedAt: () => playsAt.time, ...extra });
  const ops = makeOperations(options);
  return {
    modules,
    options,
    ops,
    playsAt,
    async call(op, input = {}) {
      const o = ops[op];
      let path = o.path;
      for (const [k, v] of Object.entries(input.params ?? {})) path = path.replace(`{${k}}`, encodeURIComponent(v));
      const u = new URL(`https://api.example.invalid${path}`);
      for (const [k, v] of Object.entries(input.query ?? {})) u.searchParams.set(k, v);
      const headers: Record<string, string> = { ...(input.headers ?? {}) };
      if (input.as) headers.authorization = `Bearer ${input.as.userId} ${input.as.type}`;
      let body: string | undefined;
      if (input.rawBody !== undefined) body = input.rawBody;
      else if (input.body !== undefined) {
        body = JSON.stringify(input.body);
        headers["content-type"] = "application/json";
      }
      const response = await o.handler(new Request(u, { method: o.method, headers, body }), modules);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    },
  };
}

export interface Account {
  userId: string;
  type: AccountType;
  artistId?: string;
  email?: string;
}

/** An account of this type. end_user has no row. */
export async function account(type: AccountType, opts: { suspended?: boolean } = {}): Promise<Account> {
  const userId = randomUUID();
  if (type === "end_user") return { userId, type };
  const email = `${type}-${userId.slice(0, 8)}@example.invalid`;
  if (type === "artist") {
    const artistId = randomUUID();
    await db.query(
      `insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name, suspended)
       values ($1::uuid, 'artist', $2::text, $3::uuid, 'Test Artist', $4::boolean)`,
      [userId, email, artistId, opts.suspended ?? false],
    );
    return { userId, type, artistId, email };
  }
  await db.query(
    "insert into public.api_accounts (user_id, account_type, email, suspended) values ($1::uuid, $2::text, $3::text, $4::boolean)",
    [userId, type, email, opts.suspended ?? false],
  );
  return { userId, type, email };
}

/** The length of a seeded track with a streaming copy: 3 minutes 20 seconds. */
export const SEEDED_DURATION_MS = 200_000;

export interface Seeded {
  releaseId: string;
  trackIds: string[];
  artistId: string;
  uploadId: string;
  /** A second master upload for track 1: open, or cancelled in taken_down (as takedown leaves it). */
  openUploadId: string;
  streamKey: string;
  coverKey: string;
}

/**
 * A release in any state, written straight in with session B's triggers off (test only), with
 * a confirmed master, a streaming copy key, a cover and an upload row, so read access can be
 * checked in every state. Plus an open upload (cancelled in taken_down) for getUpload, which
 * answers 409 for any upload that is not open. Real moves are tested through the handlers.
 */
export async function seedRelease(owner: Account, state: ReleaseState, opts: { tracks?: number } = {}): Promise<Seeded> {
  const tracks = opts.tracks ?? 1;
  const releaseId = randomUUID();
  const artistId = owner.artistId!;
  const trackIds = Array.from({ length: tracks }, () => randomUUID());
  const uploadId = randomUUID();
  const coverUploadId = randomUUID();
  const openUploadId = randomUUID();
  const streamKey = `streams/${artistId}/${releaseId}/${trackIds[0]}/stream.m4a`;
  const coverKey = `art/${artistId}/${releaseId}/cover/original`;
  await db.transaction(async (tx) => {
    await tx.query("set local session_replication_role = replica");
    const approved = ["scheduled", "live"].includes(state);
    await tx.query(
      `insert into public.api_releases (id, owner_id, artist_id, title, release_date, state, failure_reason,
                                        review_decision, review_reason, review_decided_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'Seeded', date '2026-05-01', $4::text,
               case when $4::text = 'failed' then 'The master could not be read.' end,
               case when $5::boolean then 'approved' when $4::text = 'needs_changes' then 'needs_changes' else 'none' end,
               case when $4::text = 'needs_changes' then 'Fix the title.' end,
               case when $5::boolean or $4::text = 'needs_changes' then now() end)`,
      [releaseId, owner.userId, artistId, state, approved],
    );
    for (const [i, trackId] of trackIds.entries()) {
      await tx.query(
        `insert into public.api_tracks (id, release_id, position, title, master_upload_id, master_key, master_format,
                                        master_size_bytes, master_sha256, master_confirmed_at, stream_key, duration_ms)
         values ($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid,
                 format('masters/%s/%s/%s/original', $6::text, $2::text, $1::text), 'wav', 1000, repeat('a', 64), now(),
                 $7::text, case when $7::text is null then null else ${SEEDED_DURATION_MS} end)`,
        [trackId, releaseId, i + 1, `Track ${i + 1}`, uploadId, artistId, i === 0 ? streamKey : null],
      );
    }
    await tx.query(
      `insert into public.api_uploads (id, release_id, track_id, kind, method, provider_upload_id, object_key, format,
                                       size_bytes, state, sha256, confirmed_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'master', 'tus', 'seeded', format('masters/%s/%s/%s/original', $4::text, $2::text, $3::text),
               'wav', 1000, 'confirmed', repeat('a', 64), now())`,
      [uploadId, releaseId, trackIds[0], artistId],
    );
    await tx.query(
      `insert into public.api_uploads (id, release_id, kind, method, provider_upload_id, object_key, format,
                                       size_bytes, state, sha256, confirmed_at)
       values ($1::uuid, $2::uuid, 'cover', 'tus', 'seeded-cover', $3::text, 'png', 100, 'confirmed', repeat('b', 64), now())`,
      [coverUploadId, releaseId, coverKey],
    );
    await tx.query(
      `insert into public.api_covers (release_id, upload_id, object_key, format, size_bytes, width, height)
       values ($1::uuid, $2::uuid, $3::text, 'png', 100, 3000, 3000)`,
      [releaseId, coverUploadId, coverKey],
    );
    await tx.query(
      `insert into public.api_uploads (id, release_id, track_id, kind, method, provider_upload_id, object_key, format,
                                       size_bytes, state)
       values ($1::uuid, $2::uuid, $3::uuid, 'master', 'tus', 'seeded-open', format('masters/%s/%s/%s/original', $4::text, $2::text, $3::text),
               'wav', 1000, $5::text)`,
      [openUploadId, releaseId, trackIds[0], artistId, state === "taken_down" ? "cancelled" : "open"],
    );
  });
  return { releaseId, trackIds, artistId, uploadId, openUploadId, streamKey, coverKey };
}

/** Moves a release straight to a state with triggers off (test only). */
export async function forceState(releaseId: string, state: ReleaseState) {
  await db.transaction(async (tx) => {
    await tx.query("set local session_replication_role = replica");
    await tx.query("update public.api_releases set state = $2::text where id = $1::uuid", [releaseId, state]);
  });
}

export async function releaseState(releaseId: string): Promise<string> {
  const [r] = await db.query<{ state: string }>("select state from public.api_releases where id = $1::uuid", [releaseId]);
  return r.state;
}

export const uuid = () => randomUUID();

/** A PNG header: signature and IHDR with this width and height. */
export function pngHead(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

/** A JPEG header: SOI, an APP1 block of `padding` bytes, then a baseline SOF0. */
export function jpegHead(width: number, height: number, padding = 100): Uint8Array {
  const app = new Uint8Array(4 + padding);
  app.set([0xff, 0xe1, ((padding + 2) >> 8) & 0xff, (padding + 2) & 0xff]);
  const sof = Uint8Array.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  const out = new Uint8Array(2 + app.length + sof.length + 9);
  out.set([0xff, 0xd8]);
  out.set(app, 2);
  out.set(sof, 2 + app.length);
  return out;
}

/**
 * A real play through recordPlays: a start, then the rest `seconds` of server time later in a
 * second batch (a progress halfway and an end). Moves the harness's receive clock on by a
 * minute afterwards, so the next play by the same account does not overlap this one. Returns
 * the play id and both responses.
 */
export async function realPlay(
  h: Harness,
  as: Account,
  trackId: string,
  opts: { seconds?: number; endPositionMs?: number } = {},
): Promise<{ playId: string; first: { status: number; body: any }; second: { status: number; body: any } }> {
  const seconds = opts.seconds ?? 31;
  const endPositionMs = opts.endPositionMs ?? seconds * 1000;
  const playId = randomUUID();
  const t0 = h.playsAt.time;
  const at = (s: number) => new Date(t0.getTime() + s * 1000).toISOString();
  const first = await h.call("recordPlays", {
    as,
    headers: { "idempotency-key": randomUUID() },
    body: { events: [{ type: "start", trackId, playId, positionMs: 0, occurredAt: at(0) }] },
  });
  h.playsAt.time = new Date(t0.getTime() + seconds * 1000);
  const second = await h.call("recordPlays", {
    as,
    headers: { "idempotency-key": randomUUID() },
    body: {
      events: [
        { type: "progress", trackId, playId, positionMs: Math.floor(endPositionMs / 2), occurredAt: at(seconds / 2) },
        { type: "end", trackId, playId, positionMs: endPositionMs, occurredAt: at(seconds) },
      ],
    },
  });
  h.playsAt.time = new Date(t0.getTime() + 60_000 + seconds * 1000);
  return { playId, first, second };
}

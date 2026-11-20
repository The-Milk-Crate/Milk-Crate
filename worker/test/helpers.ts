// Test helpers: audio made with ffmpeg at test time (no audio files are committed), an
// in-memory storage, and releases in `processing` made through session B's SQL functions on the
// throwaway Postgres from test/run.sh.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresDatabase, type ClosableDatabase } from "../../deploy/supabase/src/database.ts";
import type { AudioFormat, WorkerStorage } from "../src/types.ts";

export const DB_URL = process.env.MC_TEST_DB_URL;
export const NEEDS_DB = DB_URL ? false : "needs MC_TEST_DB_URL (run bash worker/test/run.sh)";

export function testDb(): ClosableDatabase {
  return postgresDatabase({ url: DB_URL!, max: 2 });
}

export interface AudioOptions {
  seconds?: number;
  sampleRate?: number;
  channels?: number;
  /** A silent file instead of a tone. */
  silent?: boolean;
  /** More ffmpeg output options, such as ["-c:a", "pcm_s24le"]. */
  extra?: string[];
}

/** A small audio file of the format, made with ffmpeg now. */
export function makeAudio(format: AudioFormat | "mp3", options: AudioOptions = {}): Uint8Array {
  const seconds = options.seconds ?? 2;
  const rate = options.sampleRate ?? 44100;
  const dir = mkdtempSync(join(tmpdir(), "mc-audio-"));
  try {
    const file = join(dir, `a.${format === "aiff" ? "aif" : format}`);
    const source = options.silent
      ? `anullsrc=r=${rate}:cl=${(options.channels ?? 2) === 1 ? "mono" : "stereo"}`
      : `sine=frequency=440:sample_rate=${rate}`;
    execFileSync("ffmpeg", [
      "-v", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", source,
      "-t", String(seconds),
      "-ac", String(options.channels ?? 2),
      ...(format === "mp3" ? ["-c:a", "libmp3lame"] : []),
      ...(options.extra ?? []),
      file,
    ]);
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Storage in memory, with the calls it got. `failPutAfter` makes the nth put and later throw. */
export class MemoryStorage implements WorkerStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  reads: string[] = [];
  puts: string[] = [];
  deletes: string[] = [];
  failPutAt: number | null = null;
  /** Runs before each put is stored (to change the database part way through a job). */
  beforePut: ((key: string) => Promise<void>) | null = null;

  async read(key: string): Promise<ReadableStream<Uint8Array>> {
    this.reads.push(key);
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error(`no object at ${key}`), { status: 404 });
    const bytes = o.bytes;
    let at = 0;
    // Small pieces, like a network read.
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= bytes.length) return c.close();
        c.enqueue(bytes.slice(at, at + 65536));
        at += 65536;
      },
    });
  }

  async put(key: string, body: ReadableStream<Uint8Array>, options: { contentType: string; sizeBytes: number }): Promise<void> {
    this.puts.push(key);
    if (this.failPutAt !== null && this.puts.length >= this.failPutAt) {
      await body.cancel();
      throw new Error("storage is down (test)");
    }
    if (this.beforePut) await this.beforePut(key);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.length !== options.sizeBytes) throw new Error(`put: ${bytes.length} bytes, not ${options.sizeBytes}`);
    this.objects.set(key, { bytes, contentType: options.contentType });
  }

  async delete(prefix: string): Promise<void> {
    this.deletes.push(prefix);
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
  }

  keys(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export interface MasterSpec {
  /** What the artist declared. */
  format: AudioFormat;
  bytes: Uint8Array;
  /** What the client sent at confirm. Default: the real SHA-256 of `bytes`. */
  sha256?: string;
}

export interface ReleaseFixture {
  artistId: string;
  releaseId: string;
  trackIds: string[];
  masterKeys: string[];
  jobId: string;
}

/**
 * A release in `processing` with one track per master, through session B's functions, each
 * master stored at its key (put straight into the store's map), and its queued job.
 */
export async function processingRelease(
  db: ClosableDatabase,
  masters: MasterSpec[],
  store: (key: string, bytes: Uint8Array, format: AudioFormat) => void | Promise<void>,
): Promise<ReleaseFixture> {
  const [{ user_id, artist_id }] = await db.query<{ user_id: string; artist_id: string }>(
    `insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name)
     values (gen_random_uuid(), 'artist', 'a@example.invalid', gen_random_uuid(), 'Test Artist')
     returning user_id::text as user_id, artist_id::text as artist_id`,
  );
  const [{ id: releaseId }] = await db.query<{ id: string }>(
    "insert into public.api_releases (owner_id, title, release_date) values ($1::uuid, 'Test', current_date) returning id::text as id",
    [user_id],
  );
  const trackIds: string[] = [];
  for (let i = 1; i <= masters.length; i++) {
    const [t] = await db.query<{ id: string }>(
      "insert into public.api_tracks (release_id, position, title) values ($1::uuid, $2::int, $3::text) returning id::text as id",
      [releaseId, i, `Song ${i}`],
    );
    trackIds.push(t.id);
  }
  const masterKeys: string[] = [];
  for (const [i, m] of masters.entries()) {
    const [s] = await db.query<{ upload_id: string; object_key: string }>(
      `select upload_id::text as upload_id, object_key from public.api_start_upload($1::uuid, $2::uuid, 'master', 'tus', 'prov', $3::text, $4::bigint, now() + interval '1 day')`,
      [releaseId, trackIds[i], m.format, Math.max(1, m.bytes.length)],
    );
    masterKeys.push(s.object_key);
    await store(s.object_key, m.bytes, m.format);
    await db.query("select 1 from public.api_confirm_upload($1::uuid, $2::text, null, null, null)", [
      s.upload_id,
      m.sha256 ?? sha256(m.bytes),
    ]);
  }
  const [{ state }] = await db.query<{ state: string }>("select state from public.api_releases where id = $1::uuid", [releaseId]);
  if (state !== "processing") throw new Error(`fixture: release is ${state}, not processing`);
  const [{ id: jobId }] = await db.query<{ id: string }>(
    "select public.api_create_job($1::uuid, 'process_release')::text as id",
    [releaseId],
  );
  return { artistId: artist_id, releaseId, trackIds, masterKeys, jobId };
}

export interface TrackRow {
  stream_key: string | null;
  duration_ms: number | null;
  sample_rate_hz: number | null;
}

export async function trackRows(db: ClosableDatabase, releaseId: string): Promise<TrackRow[]> {
  return db.query<TrackRow>(
    "select stream_key, duration_ms, sample_rate_hz from public.api_tracks where release_id = $1::uuid order by position",
    [releaseId],
  );
}

/** Start the job (as the skeleton's api_job_started does) and apply a result (as G's function does). */
export async function startJob(db: ClosableDatabase, jobId: string): Promise<void> {
  await db.query("select public.api_job_started($1::uuid)", [jobId]);
}

export function streamKey(f: ReleaseFixture, i: number): string {
  return `streams/${f.artistId}/${f.releaseId}/${f.trackIds[i]}/mp3-320.mp3`;
}

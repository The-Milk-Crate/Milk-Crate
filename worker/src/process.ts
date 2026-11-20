// The processing step both workers run for a `process_release` job: for each track, stream the
// master once to a temp file while hashing it, check the SHA-256 the client sent, check what the
// file really is, decode it all the way through into the streaming copy, and write the copy
// under streams/. Then record what playback needs on every track at once. The master is never
// written. The worker skeleton claims the job before this and reports what this returns.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { probe, STREAM_CONTENT_TYPE, STREAM_FILE, transcode, type Tools } from "./media.ts";
import type { AudioFormat, JobResult, JobToRun, WorkerDatabase, WorkerStorage } from "./types.ts";
import { words, type TrackLabel } from "./words.ts";

export interface ProcessDeps {
  database: WorkerDatabase;
  storage: WorkerStorage;
  tools?: Tools;
  /** Where temp files go. Default: the system temp folder. */
  tempDir?: string;
  log?: (message: string) => void;
}

interface TrackRow extends TrackLabel {
  id: string;
  artist_id: string;
  master_key: string | null;
  master_format: AudioFormat | null;
  master_sha256: string | null;
  stream_key: string | null;
}

interface Done {
  track: TrackRow;
  streamKey: string;
  durationMs: number;
  sampleRateHz: number;
}

type TrackOutcome = { ok: true; done: Done } | { ok: false; message: string };

/** streams/{artist}/{release}/{track}/, the folder playback signs and takedown deletes. */
export function streamFolder(artistId: string, releaseId: string, trackId: string): string {
  return `streams/${artistId}/${releaseId}/${trackId}/`;
}

/** The processing step each platform's worker/main.ts passes to its skeleton (runOneJob). */
export function makeProcessRelease(deps: ProcessDeps): (job: JobToRun) => Promise<JobResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const tools = deps.tools ?? {};

  return async (job) => {
    const [release] = await deps.database.query<{ state: string }>(
      "select state from public.api_releases where id = $1::uuid",
      [job.releaseId],
    );
    if (!release || release.state !== "processing") {
      log(`job ${job.jobId}: release ${job.releaseId} is not processing (${release?.state ?? "gone"}); nothing done`);
      return { ok: false, message: words.changed };
    }
    const tracks = await deps.database.query<TrackRow>(
      `select t.id::text as id, t.position, t.title, r.artist_id::text as artist_id,
              t.master_key, t.master_format, t.master_sha256, t.stream_key
         from public.api_tracks t join public.api_releases r on r.id = t.release_id
        where t.release_id = $1::uuid
        order by t.position`,
      [job.releaseId],
    );

    const work = await mkdtemp(join(deps.tempDir ?? tmpdir(), "mc-job-"));
    // Streaming copies this job wrote, so a failure can remove them.
    const written: TrackRow[] = [];
    let kept = false;
    try {
      const done: Done[] = [];
      for (const track of tracks) {
        const outcome = await processTrack(track, job, work, written);
        if (!outcome.ok) {
          log(`job ${job.jobId}: track ${track.id} failed: ${outcome.message}`);
          return { ok: false, message: outcome.message };
        }
        done.push(outcome.done);
      }

      // Every track passed: record them together, and only while this job is still the
      // release's newest, the release is still processing and each master is the one hashed.
      const recorded = await deps.database.transaction(async (tx) => {
        for (const d of done) {
          const rows = await tx.query<{ id: string }>(
            `update public.api_tracks t
                set stream_key = $3::text, duration_ms = $4::integer, sample_rate_hz = $5::integer
              where t.id = $1::uuid and t.release_id = $2::uuid and t.master_sha256 = $6::text
                and exists (select 1 from public.api_releases r where r.id = t.release_id and r.state = 'processing')
                and $7::uuid = (select j.id from public.api_jobs j where j.release_id = t.release_id order by j.seq desc limit 1)
              returning t.id::text as id`,
            [d.track.id, job.releaseId, d.streamKey, d.durationMs, d.sampleRateHz, d.track.master_sha256, job.jobId],
          );
          if (rows.length !== 1) return false;
        }
        return true;
      });
      if (!recorded) {
        // The release moved on (a takedown, a replaced master) or a newer job exists. The
        // cleanup below removes this job's copies unless a newer job owns those keys now.
        log(`job ${job.jobId}: release ${job.releaseId} changed while processing; nothing recorded`);
        return { ok: false, message: words.changed };
      }
      kept = true;
      log(`job ${job.jobId}: ${done.length} tracks processed`);
      return { ok: true };
    } finally {
      if (!kept) await removeWritten(written, job, log);
      await rm(work, { recursive: true, force: true });
    }
  };

  async function processTrack(track: TrackRow, job: JobToRun, work: string, written: TrackRow[]): Promise<TrackOutcome> {
    if (!track.master_key || !track.master_format || !track.master_sha256) {
      return { ok: false, message: words.noMaster(track) };
    }
    const masterFile = join(work, `${track.id}.master`);
    const streamFile = join(work, `${track.id}.mp3`);
    try {
      // 1. Stream the master once to disk, hashing it on the way.
      let source: ReadableStream<Uint8Array>;
      try {
        source = await deps.storage.read(track.master_key);
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return { ok: false, message: words.noMaster(track) };
        throw error;
      }
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(source as NodeReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(masterFile),
      );
      if (hash.digest("hex") !== track.master_sha256) return { ok: false, message: words.shaMismatch(track) };

      // 2. What the file really is.
      const probed = await probe(tools, masterFile, track.master_format);
      if (!probed.ok) {
        if (probed.reason === "no_audio") return { ok: false, message: words.noAudio(track) };
        if (probed.reason === "unreadable") return { ok: false, message: words.unreadable(track) };
        return { ok: false, message: words.wrongFormat(track, track.master_format) };
      }

      // 3. Decode it all the way through into the MP3.
      const made = await transcode(tools, masterFile, streamFile, probed.expectedSamples);
      await rm(masterFile, { force: true });
      if (!made.ok) {
        log(`job ${job.jobId}: track ${track.id}: ffmpeg said: ${made.detail}`);
        if (made.reason === "no_audio") return { ok: false, message: words.noAudio(track) };
        if (made.reason === "unreadable") return { ok: false, message: words.unreadable(track) };
        return { ok: false, message: words.damaged(track) };
      }
      const durationMs = Math.max(1, Math.round((made.samples * 1000) / probed.sampleRateHz));

      // 4. Write the copy. A retried job writes the same key again.
      const streamKey = streamFolder(track.artist_id, job.releaseId, track.id) + STREAM_FILE;
      const { size } = await stat(streamFile);
      written.push(track);
      await deps.storage.put(streamKey, Readable.toWeb(createReadStream(streamFile)) as ReadableStream<Uint8Array>, {
        contentType: STREAM_CONTENT_TYPE,
        sizeBytes: size,
      });
      return { ok: true, done: { track, streamKey, durationMs, sampleRateHz: probed.sampleRateHz } };
    } finally {
      await rm(masterFile, { force: true });
      await rm(streamFile, { force: true });
    }
  }

  /**
   * When nothing was recorded (a failure, a crash, or the release moved on): remove the copies
   * this job wrote, so none is left behind, also after a takedown during the job. Two cases
   * keep files, decided from the database as it is now:
   *   - a newer job exists for the release: it writes the same keys, so its files are left alone;
   *   - a track has a recorded copy (an earlier successful job, same master): its stream_key
   *     still points at the file.
   */
  async function removeWritten(written: TrackRow[], job: JobToRun, log: (m: string) => void): Promise<void> {
    if (written.length === 0) return;
    let keep: Set<string>;
    try {
      const [newest] = await deps.database.query<{ id: string }>(
        "select j.id::text as id from public.api_jobs j where j.release_id = $1::uuid order by j.seq desc limit 1",
        [job.releaseId],
      );
      if (newest && newest.id !== job.jobId) {
        log(`job ${job.jobId}: a newer job (${newest.id}) owns this release's copies; left them alone`);
        return;
      }
      const recorded = await deps.database.query<{ id: string }>(
        "select t.id::text as id from public.api_tracks t where t.release_id = $1::uuid and t.stream_key is not null",
        [job.releaseId],
      );
      keep = new Set(recorded.map((r) => r.id));
    } catch (error) {
      // Without the database it is not safe to choose; the next successful job overwrites it, or a takedown deletes it.
      log(`job ${job.jobId}: could not check what to remove: ${(error as Error)?.message ?? String(error)}`);
      return;
    }
    for (const track of written) {
      if (keep.has(track.id)) continue;
      const folder = streamFolder(track.artist_id, job.releaseId, track.id);
      try {
        await deps.storage.delete(folder);
      } catch (error) {
        // Not fatal for the result; the next successful job overwrites it, or a takedown deletes it.
        log(`job ${job.jobId}: could not remove ${folder}: ${(error as Error)?.message ?? String(error)}`);
      }
    }
  }
}

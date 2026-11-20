// Opt-in, not run by default (MC_SLOW=1 bash worker/test/run.sh): a 2 GB WAV streamed through
// the processing step, checking this process's memory stays small (the master is never held in
// memory) and how long it takes. Needs about 5 GB of free disk in the temp folder.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { makeProcessRelease } from "../src/index.ts";
import type { WorkerStorage } from "../src/types.ts";
import type { ClosableDatabase } from "../../deploy/supabase/src/database.ts";
import { NEEDS_DB, processingRelease, startJob, testDb, trackRows } from "./helpers.ts";

const SLOW = process.env.MC_SLOW === "1" ? false : "opt-in: MC_SLOW=1 bash worker/test/run.sh";
// 2 GB of 16-bit stereo at 44.1 kHz: about 3 hours 9 minutes.
const SECONDS = Math.ceil(2_000_000_000 / (44100 * 2 * 2));

describe("a 2 GB WAV streams through with small memory", { skip: NEEDS_DB || SLOW }, () => {
  let db: ClosableDatabase;
  let dir: string;
  before(() => {
    db = testDb();
    dir = mkdtempSync(join(tmpdir(), "mc-slow-"));
  });
  after(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("2 GB WAV → 320 kbps MP3", { timeout: 60 * 60 * 1000 }, async () => {
    const master = join(dir, "big.wav");
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100",
      "-t", String(SECONDS), "-ac", "2", "-c:a", "pcm_s16le", master]);
    const size = statSync(master).size;
    assert.ok(size >= 2_000_000_000, `the master is ${size} bytes`);
    const hash = createHash("sha256");
    await pipeline(createReadStream(master), hash);
    const sha = hash.digest("hex");

    // Storage on disk: the master streams from the file; the copy is counted, not kept.
    let written = 0;
    const storage: WorkerStorage = {
      read: async () => Readable.toWeb(createReadStream(master)) as ReadableStream<Uint8Array>,
      put: async (_key, body, options) => {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) written += chunk.length;
        assert.equal(written, options.sizeBytes);
      },
      delete: async () => {},
    };
    const f = await processingRelease(db, [{ format: "wav", bytes: new Uint8Array(0), sha256: sha }], () => {});
    // The fixture recorded size 1 (it was given no bytes); record the real size.
    await db.query("update public.api_tracks set master_size_bytes = $2::bigint where id = $1::uuid", [f.trackIds[0], size]);
    await startJob(db, f.jobId);

    let peakRss = 0;
    let peakFfmpegKib = 0;
    const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
    // ffmpeg's own memory, for sizing the machines.
    const sampleFfmpeg = setInterval(() => {
      try {
        const out = execFileSync("ps", ["-C", "ffmpeg", "-o", "rss="]).toString();
        for (const n of out.split("\n").map(Number).filter((x) => x > 0)) peakFfmpegKib = Math.max(peakFfmpegKib, n);
      } catch { /* not running at that moment */ }
    }, 2000);
    const startRss = process.memoryUsage().rss;
    const started = Date.now();
    const result = await makeProcessRelease({ database: db, storage, tempDir: dir, log: () => {} })({ jobId: f.jobId, releaseId: f.releaseId });
    clearInterval(sample);
    clearInterval(sampleFfmpeg);
    const seconds = (Date.now() - started) / 1000;

    assert.deepEqual(result, { ok: true });
    const [row] = await trackRows(db, f.releaseId);
    assert.equal(row.duration_ms, SECONDS * 1000);
    const mib = (n: number) => Math.round(n / 1024 / 1024);
    console.log(`2 GB WAV (${size} bytes, ${SECONDS} s of audio): ${seconds.toFixed(0)} s, ` +
      `${(SECONDS / seconds).toFixed(0)}x real time, ${(size / 1024 / 1024 / seconds).toFixed(0)} MiB/s; ` +
      `MP3 ${mib(written)} MiB; node RSS ${mib(startRss)} MiB at start, peak ${mib(peakRss)} MiB; ` +
      `ffmpeg peak ${Math.round(peakFfmpegKib / 1024)} MiB`);
    assert.ok(peakRss - startRss < 256 * 1024 * 1024, `node memory grew by ${mib(peakRss - startRss)} MiB`);
  });
});

// The processing step against in-memory storage and the throwaway Postgres: each format, every
// failure the brief lists, a retried job and the cleanup after a failure.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProcessRelease } from "../src/index.ts";
import type { ClosableDatabase } from "../../deploy/supabase/src/database.ts";
import {
  MemoryStorage,
  NEEDS_DB,
  makeAudio,
  processingRelease,
  sha256,
  startJob,
  streamKey,
  testDb,
  trackRows,
  type AudioOptions,
  type MasterSpec,
} from "./helpers.ts";

/** Duration and sample rate of an MP3, read back with ffprobe. */
function probeMp3(bytes: Uint8Array): { codec: string; sampleRate: number; channels: number; bitRate: number; seconds: number } {
  const dir = mkdtempSync(join(tmpdir(), "mc-check-"));
  try {
    writeFileSync(join(dir, "s.mp3"), bytes);
    const out = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries",
        "format=format_name,duration:stream=codec_name,sample_rate,channels,bit_rate", join(dir, "s.mp3")]).toString(),
    );
    return {
      codec: out.streams[0].codec_name,
      sampleRate: Number(out.streams[0].sample_rate),
      channels: out.streams[0].channels,
      bitRate: Number(out.streams[0].bit_rate),
      seconds: Number(out.format.duration),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("processing a release (local Postgres, storage in memory)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  let temp: string;
  before(() => {
    db = testDb();
    temp = mkdtempSync(join(tmpdir(), "mc-worker-test-"));
  });
  after(async () => {
    await db.close();
    rmSync(temp, { recursive: true, force: true });
  });

  async function setup(masters: MasterSpec[]) {
    const storage = new MemoryStorage();
    const f = await processingRelease(db, masters, (key, bytes, format) => {
      storage.objects.set(key, { bytes, contentType: `audio/${format}` });
    });
    await startJob(db, f.jobId);
    const logs: string[] = [];
    const process = makeProcessRelease({ database: db, storage, tempDir: temp, log: (m) => logs.push(m) });
    const run = () => process({ jobId: f.jobId, releaseId: f.releaseId });
    return { storage, f, run, logs };
  }

  const masterBytes = (storage: MemoryStorage, keys: string[]) => keys.map((k) => sha256(storage.objects.get(k)!.bytes));

  test("WAV, AIFF and FLAC masters each become a 320 kbps MP3 at mp3-320.mp3, with duration and sample rate recorded", async () => {
    const masters: MasterSpec[] = [
      { format: "wav", bytes: makeAudio("wav", { seconds: 2, sampleRate: 44100 }) },
      { format: "aiff", bytes: makeAudio("aiff", { seconds: 3, sampleRate: 48000 }) },
      { format: "flac", bytes: makeAudio("flac", { seconds: 1.5, sampleRate: 96000, channels: 1 }) },
    ];
    const { storage, f, run } = await setup(masters);
    const before = masterBytes(storage, f.masterKeys);

    assert.deepEqual(await run(), { ok: true });

    assert.deepEqual(await trackRows(db, f.releaseId), [
      { stream_key: streamKey(f, 0), duration_ms: 2000, sample_rate_hz: 44100 },
      { stream_key: streamKey(f, 1), duration_ms: 3000, sample_rate_hz: 48000 },
      { stream_key: streamKey(f, 2), duration_ms: 1500, sample_rate_hz: 96000 },
    ]);
    for (const [i, seconds] of [2, 3, 1.5].entries()) {
      const copy = storage.objects.get(streamKey(f, i))!;
      assert.equal(copy.contentType, "audio/mpeg");
      const info = probeMp3(copy.bytes);
      assert.equal(info.codec, "mp3");
      assert.equal(info.sampleRate, 44100, "44.1 kHz, as the desktop app makes");
      assert.equal(info.channels, 2);
      assert.equal(info.bitRate, 320_000, `about 320 kbps, got ${info.bitRate}`);
      assert.ok(Math.abs(info.seconds - seconds) < 0.1, `about ${seconds} s, got ${info.seconds}`);
    }
    // The masters are read once each and never written or deleted.
    assert.deepEqual(storage.reads, f.masterKeys);
    assert.deepEqual(masterBytes(storage, f.masterKeys), before);
    assert.ok(storage.puts.every((k) => k.startsWith("streams/")));
    assert.deepEqual(storage.deletes, []);
    assert.deepEqual(readdirSync(temp), [], "temp files are removed");
  });

  test("a silent track passes", async () => {
    const { f, run } = await setup([{ format: "wav", bytes: makeAudio("wav", { seconds: 1, silent: true }) }]);
    assert.deepEqual(await run(), { ok: true });
    assert.equal((await trackRows(db, f.releaseId))[0].duration_ms, 1000);
  });

  test("a file whose content does not match the declared format fails, naming the format", async () => {
    const cases: [MasterSpec, string][] = [
      [{ format: "flac", bytes: makeAudio("wav") }, "FLAC"],
      [{ format: "wav", bytes: makeAudio("flac") }, "WAV"],
      [{ format: "aiff", bytes: makeAudio("wav") }, "AIFF"],
      [{ format: "wav", bytes: makeAudio("mp3") }, "WAV"],
      [{ format: "flac", bytes: new TextEncoder().encode("not audio at all, just some words in a text file") }, "FLAC"],
    ];
    for (const [spec, name] of cases) {
      const { storage, f, run } = await setup([spec]);
      assert.deepEqual(await run(), {
        ok: false,
        message: `Track 1, "Song 1": this file is not a valid ${name}. Export it again and upload it.`,
      });
      assert.deepEqual(storage.puts, [], "nothing is written");
      assert.deepEqual((await trackRows(db, f.releaseId))[0], { stream_key: null, duration_ms: null, sample_rate_hz: null });
    }
  });

  test("a truncated file fails as damaged, in each format", async () => {
    for (const format of ["wav", "aiff", "flac"] as const) {
      const whole = makeAudio(format, { seconds: 3 });
      const { storage, run } = await setup([{ format, bytes: whole.slice(0, Math.floor(whole.length / 2)) }]);
      assert.deepEqual(await run(), {
        ok: false,
        message: 'Track 1, "Song 1": this file is damaged or incomplete, so it could not be read all the way through. Export it again and upload it.',
      }, format);
      assert.deepEqual(storage.puts, [], `${format}: nothing is written`);
    }
  });

  test("a WAV cut exactly on a packet boundary still fails as damaged (its header declares more)", async () => {
    // ffmpeg reads WAV in 4096-byte packets (4092 for 24-bit stereo), so a cut there logs no error;
    // the length the header's data chunk declares is what catches it.
    const cases: [AudioOptions, number][] = [
      [{ channels: 2 }, 4096],
      [{ channels: 1 }, 4096],
      [{ channels: 2, extra: ["-c:a", "pcm_s24le"] }, 4092],
    ];
    for (const [options, packet] of cases) {
      const whole = makeAudio("wav", { seconds: 3, ...options });
      const dataStart = Buffer.from(whole).indexOf("data") + 8;
      const { storage, run } = await setup([{ format: "wav", bytes: whole.slice(0, dataStart + 10 * packet) }]);
      assert.deepEqual(await run(), {
        ok: false,
        message: 'Track 1, "Song 1": this file is damaged or incomplete, so it could not be read all the way through. Export it again and upload it.',
      }, JSON.stringify(options));
      assert.deepEqual(storage.puts, []);
    }
  });

  test("valid edge cases pass with exact durations: 24-bit, RF64, AIFF-C, and a title that reads [error]", async () => {
    const { f, run } = await setup([
      { format: "wav", bytes: makeAudio("wav", { seconds: 1, extra: ["-c:a", "pcm_s24le"] }) },
      { format: "wav", bytes: makeAudio("wav", { seconds: 1, extra: ["-rf64", "always"] }) },
      { format: "aiff", bytes: makeAudio("aiff", { seconds: 1, extra: ["-c:a", "pcm_s16le", "-f", "aiff"] }) },
      { format: "flac", bytes: makeAudio("flac", { seconds: 1, extra: ["-metadata", "title=[error] not really"] }) },
    ]);
    assert.deepEqual(await run(), { ok: true });
    assert.deepEqual((await trackRows(db, f.releaseId)).map((t) => t.duration_ms), [1000, 1000, 1000, 1000]);
  });

  test("an empty file fails", async () => {
    const { storage, run } = await setup([{ format: "wav", bytes: new Uint8Array(0) }]);
    assert.deepEqual(await run(), {
      ok: false,
      message: 'Track 1, "Song 1": this file is not a valid WAV. Export it again and upload it.',
    });
    assert.deepEqual(storage.puts, []);
  });

  test("a FLAC with no samples fails: its length cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-empty-flac-"));
    try {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "0", join(dir, "z.flac")]);
      const { run } = await setup([{ format: "flac", bytes: new Uint8Array(readFileSync(join(dir, "z.flac"))) }]);
      assert.deepEqual(await run(), {
        ok: false,
        message: 'Track 1, "Song 1": we could not read this file\'s length or sample rate. Export it again and upload it.',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrong SHA-256 fails before any copy is made", async () => {
    const bytes = makeAudio("flac");
    const { storage, run } = await setup([{ format: "flac", bytes, sha256: "0".repeat(64) }]);
    assert.deepEqual(await run(), {
      ok: false,
      message: 'Track 1, "Song 1": the file we received is not the one your app sent (its checksum does not match). Upload the master for this track again.',
    });
    assert.deepEqual(storage.puts, []);
  });

  test("a master missing from storage fails in plain words", async () => {
    const { storage, f, run } = await setup([{ format: "wav", bytes: makeAudio("wav") }]);
    storage.objects.delete(f.masterKeys[0]);
    assert.deepEqual(await run(), {
      ok: false,
      message: 'Track 1, "Song 1": we could not find its uploaded file. Upload the master for this track again.',
    });
  });

  test("one bad track fails the release with that track's reason, and removes the copies already written", async () => {
    const { storage, f, run } = await setup([
      { format: "wav", bytes: makeAudio("wav") },
      { format: "aiff", bytes: makeAudio("aiff") },
      { format: "flac", bytes: makeAudio("wav") },
    ]);
    const result = await run();
    assert.deepEqual(result, {
      ok: false,
      message: 'Track 3, "Song 3": this file is not a valid FLAC. Export it again and upload it.',
    });
    assert.deepEqual(storage.puts, [streamKey(f, 0), streamKey(f, 1)]);
    assert.deepEqual(storage.keys("streams/"), [], "no half-written derived files");
    assert.deepEqual(storage.deletes, [0, 1].map((i) => streamKey(f, i).replace(/mp3-320\.mp3$/, "")));
    assert.deepEqual((await trackRows(db, f.releaseId)).map((t) => t.stream_key), [null, null, null]);
    assert.equal(storage.keys("masters/").length, 3, "masters untouched");
    assert.deepEqual(readdirSync(temp), []);
  });

  test("a storage failure part way throws (the skeleton reports it plainly), after removing what was written", async () => {
    const { storage, f, run } = await setup([
      { format: "wav", bytes: makeAudio("wav") },
      { format: "wav", bytes: makeAudio("wav") },
    ]);
    storage.failPutAt = 2;
    await assert.rejects(run(), /storage is down/);
    assert.deepEqual(storage.keys("streams/"), []);
    assert.equal(storage.deletes.length, 2);
    assert.deepEqual((await trackRows(db, f.releaseId)).map((t) => t.stream_key), [null, null]);
    assert.deepEqual(readdirSync(temp), []);
  });

  test("a retried job gives the same result at the same keys", async () => {
    const { storage, f, run } = await setup([
      { format: "wav", bytes: makeAudio("wav", { seconds: 1 }) },
      { format: "flac", bytes: makeAudio("flac", { seconds: 2 }) },
    ]);
    assert.deepEqual(await run(), { ok: true });
    const first = await trackRows(db, f.releaseId);
    const firstCopies = storage.keys("streams/").map((k) => sha256(storage.objects.get(k)!.bytes));
    assert.deepEqual(await run(), { ok: true });
    assert.deepEqual(await trackRows(db, f.releaseId), first);
    assert.deepEqual(storage.keys("streams/"), [streamKey(f, 0), streamKey(f, 1)].sort());
    assert.deepEqual(storage.keys("streams/").map((k) => sha256(storage.objects.get(k)!.bytes)), firstCopies, "the same bytes");
  });

  test("a failed retry keeps the copy an earlier run recorded, and removes only new ones", async () => {
    const { storage, f, run } = await setup([
      { format: "wav", bytes: makeAudio("wav") },
      { format: "wav", bytes: makeAudio("wav") },
    ]);
    // Track 1's copy was recorded earlier (with this master); track 2's never was.
    const key0 = streamKey(f, 0);
    await db.query("update public.api_tracks set stream_key = $2::text, duration_ms = 2000, sample_rate_hz = 44100 where id = $1::uuid", [f.trackIds[0], key0]);
    storage.failPutAt = 2;
    await assert.rejects(run(), /storage is down/);
    assert.deepEqual(storage.keys("streams/"), [key0]);
  });

  test("a stale job (a newer job exists) records nothing", async () => {
    const { storage, f, run } = await setup([{ format: "wav", bytes: makeAudio("wav") }]);
    await db.query("select public.api_create_job($1::uuid, 'process_release')", [f.releaseId]);
    assert.deepEqual(await run(), { ok: false, message: "This release changed while it was being processed, so this result was not kept." });
    assert.deepEqual((await trackRows(db, f.releaseId))[0].stream_key, null);
    assert.deepEqual(storage.deletes, [], "the newer job's files are left alone");
  });

  test("a takedown during the job: nothing is recorded and the copies it wrote are removed", async () => {
    const { storage, f, run } = await setup([
      { format: "wav", bytes: makeAudio("wav", { seconds: 1 }) },
      { format: "wav", bytes: makeAudio("wav", { seconds: 1 }) },
    ]);
    const [{ id: adminId }] = await db.query<{ id: string }>(
      "insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'administrator') returning user_id::text as id",
    );
    // An administrator takes the release down while the worker writes track 2's copy.
    storage.beforePut = async (key) => {
      if (key !== streamKey(f, 1)) return;
      await db.query("select 1 from public.api_takedown_release($1::uuid, $2::uuid, 'Test.')", [f.releaseId, adminId]);
    };
    assert.deepEqual(await run(), { ok: false, message: "This release changed while it was being processed, so this result was not kept." });
    assert.deepEqual((await trackRows(db, f.releaseId)).map((t) => t.stream_key), [null, null]);
    assert.deepEqual(storage.keys("streams/"), [], "no copy outlives the takedown");
  });

  test("a release that is no longer processing is left alone", async () => {
    const { storage, f, run } = await setup([{ format: "wav", bytes: makeAudio("wav") }]);
    await db.query("select public.api_apply_job_result($1::uuid, false, 'Stopped (test).')", [f.jobId]);
    assert.deepEqual(await run(), { ok: false, message: "This release changed while it was being processed, so this result was not kept." });
    assert.deepEqual(storage.reads, []);
  });
});

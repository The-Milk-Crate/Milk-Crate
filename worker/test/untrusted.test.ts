// Masters are untrusted (security review, M4). ffprobe and ffmpeg read a master only as the
// declared format and only from local files, and get only PATH from the worker's environment.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProcessRelease, type Tools } from "../src/index.ts";
import { probe, transcode } from "../src/media.ts";
import type { ClosableDatabase } from "../../deploy/supabase/src/database.ts";
import { MemoryStorage, NEEDS_DB, makeAudio, processingRelease, startJob, testDb, type MasterSpec } from "./helpers.ts";

/** A local HTTP server that counts the requests it gets. */
async function countingServer(): Promise<{ server: Server; base: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, requests };
}

/** Files whose content makes ffmpeg open a URL when it guesses the format. */
function trickFiles(base: string): [string, Uint8Array][] {
  const text = (s: string) => new TextEncoder().encode(s);
  return [
    ["an HLS playlist", text(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n${base}/hls/seg.wav\n#EXT-X-ENDLIST\n`)],
    ["an ffconcat file", text(`ffconcat version 1.0\nfile '${base}/concat/a.wav'\nduration 2\n`)],
  ];
}

describe("untrusted masters: no format guessing, no network, no environment", () => {
  let temp: string;
  let http: Awaited<ReturnType<typeof countingServer>>;
  before(async () => {
    temp = mkdtempSync(join(tmpdir(), "mc-untrusted-"));
    http = await countingServer();
  });
  after(async () => {
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  });

  test("ffprobe and ffmpeg refuse a playlist or concat file saved as a WAV, and open no URL", async () => {
    for (const [name, bytes] of trickFiles(http.base)) {
      const file = join(temp, "trick.master");
      writeFileSync(file, bytes);
      assert.deepEqual(await probe({}, file, "wav"), { ok: false, reason: "wrong_format" }, name);
      const made = await transcode({}, file, "wav", join(temp, "trick.mp3"), null);
      assert.equal(made.ok, false, `${name}: ffmpeg refuses it`);
      rmSync(file, { force: true });
    }
    assert.deepEqual(http.requests, [], "the server got no request");
    // The server does answer, so the empty list above means something.
    await fetch(`${http.base}/check`);
    assert.deepEqual(http.requests, ["/check"]);
    http.requests.length = 0;
  });

  test("with the format forced, a FLAC still needs its own marker; one with an ID3v2 tag in front still passes", async () => {
    // ffmpeg's FLAC reader does not check the first 4 bytes, so the step does.
    const wav = join(temp, "wav-as-flac.master");
    writeFileSync(wav, makeAudio("wav"));
    assert.deepEqual(await probe({}, wav, "flac"), { ok: false, reason: "wrong_format" });

    // A minimal ID3v2.3 tag (one title frame) in front of a real FLAC.
    const frame = Buffer.concat([Buffer.from("TIT2"), Buffer.from([0, 0, 0, 5, 0, 0, 0]), Buffer.from("Song")]);
    const size = frame.length;
    const tag = Buffer.concat([
      Buffer.from("ID3"), Buffer.from([3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
      frame,
    ]);
    const tagged = join(temp, "tagged.master");
    writeFileSync(tagged, Buffer.concat([tag, makeAudio("flac", { seconds: 1 })]));
    const probed = await probe({}, tagged, "flac");
    assert.equal(probed.ok, true);
    assert.deepEqual(await transcode({}, tagged, "flac", join(temp, "tagged.mp3"), probed.ok ? probed.expectedSamples : null), {
      ok: true,
      samples: 44100,
    });
  });

  test("ffprobe and ffmpeg get only PATH, and still process a WAV, AIFF and FLAC", async () => {
    // Fakes that write the environment they got to a file, then run the real tool with it.
    const dumps = join(temp, "env");
    const fake = (tool: "ffprobe" | "ffmpeg") => {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim();
      const path = join(temp, `fake-${tool}`);
      writeFileSync(
        path,
        `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(dumps)}, JSON.stringify({ tool: ${JSON.stringify(tool)}, env: process.env }) + "\\n");
const r = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
      );
      chmodSync(path, 0o755);
      return path;
    };
    const tools: Tools = { ffprobe: fake("ffprobe"), ffmpeg: fake("ffmpeg") };

    // Something like a secret in the worker's own environment.
    process.env.MC_TEST_SECRET = "must-not-reach-ffmpeg";
    try {
      for (const format of ["wav", "aiff", "flac"] as const) {
        const file = join(temp, `real.${format}`);
        writeFileSync(file, makeAudio(format, { seconds: 1 }));
        const probed = await probe(tools, file, format);
        assert.equal(probed.ok, true, `${format}: probe passes`);
        const made = await transcode(tools, file, format, join(temp, `real-${format}.mp3`), probed.ok ? probed.expectedSamples : null);
        assert.deepEqual(made, { ok: true, samples: 44100 }, `${format}: ffmpeg decodes it all with PATH only`);
      }
    } finally {
      delete process.env.MC_TEST_SECRET;
    }

    const seen = readFileSync(dumps, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool: string; env: Record<string, string> });
    assert.equal(seen.length, 6, "each tool ran three times");
    for (const { tool, env } of seen) {
      assert.deepEqual(env, { PATH: process.env.PATH }, `${tool} got only PATH`);
    }
  });
});

describe("untrusted masters through the processing step (local Postgres)", { skip: NEEDS_DB }, () => {
  let db: ClosableDatabase;
  let temp: string;
  let http: Awaited<ReturnType<typeof countingServer>>;
  before(async () => {
    db = testDb();
    temp = mkdtempSync(join(tmpdir(), "mc-untrusted-job-"));
    http = await countingServer();
  });
  after(async () => {
    await db.close();
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  });

  test("a playlist or concat file declared as WAV fails the job as not a valid WAV, and the server sees no request", async () => {
    for (const [name, bytes] of trickFiles(http.base)) {
      const storage = new MemoryStorage();
      const masters: MasterSpec[] = [{ format: "wav", bytes }];
      const f = await processingRelease(db, masters, (key, b, format) => {
        storage.objects.set(key, { bytes: b, contentType: `audio/${format}` });
      });
      await startJob(db, f.jobId);
      const run = makeProcessRelease({ database: db, storage, tempDir: temp, log: () => {} });
      assert.deepEqual(
        await run({ jobId: f.jobId, releaseId: f.releaseId }),
        { ok: false, message: 'Track 1, "Song 1": this file is not a valid WAV. Export it again and upload it.' },
        name,
      );
      assert.deepEqual(storage.puts, [], `${name}: nothing is written`);
    }
    assert.deepEqual(http.requests, [], "the server got no request");
    assert.deepEqual(readdirSync(temp), [], "temp files are removed");
  });
});

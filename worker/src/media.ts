// ffprobe and ffmpeg: check what a master really is, then decode it all the way through while
// making the streaming copy.
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import type { AudioFormat } from "./types.ts";

export interface Tools {
  /** Default "ffmpeg" (from PATH). */
  ffmpeg?: string;
  /** Default "ffprobe" (from PATH). */
  ffprobe?: string;
}

/** The streaming copy: one rendition, 320 kbps MP3, 44.1 kHz stereo, as the desktop app makes. */
export const STREAM_FILE = "mp3-320.mp3";
export const STREAM_CONTENT_TYPE = "audio/mpeg";

/** The container and codecs each declared format may hold. */
const ALLOWED: Record<AudioFormat, { container: string; codec: (name: string) => boolean }> = {
  wav: { container: "wav", codec: (c) => c.startsWith("pcm_") },
  aiff: { container: "aiff", codec: (c) => c.startsWith("pcm_") },
  flac: { container: "flac", codec: (c) => c === "flac" },
};

export type ProbeResult =
  | { ok: true; sampleRateHz: number; channels: number; expectedSamples: number | null }
  | { ok: false; reason: "wrong_format" | "no_audio" | "unreadable" };

interface Run {
  code: number | null;
  stdout: string;
  /** The last lines of stderr. */
  stderr: string[];
  /** stderr lines at error level or worse. */
  errors: string[];
}

/** The ffmpeg demuxer for each declared format. */
const DEMUXER: Record<AudioFormat, string> = { wav: "wav", aiff: "aiff", flac: "flac" };

/**
 * Masters are untrusted. Both commands read the input only as the declared format (no format
 * guessing, so no playlist or concat file) and only from local files (no other protocol).
 */
function inputOptions(declared: AudioFormat): string[] {
  return ["-f", DEMUXER[declared], "-protocol_whitelist", "file"];
}

/**
 * The environment ffprobe and ffmpeg get: only PATH, so they never see the worker's database
 * password, service key or cloud credentials.
 */
function toolEnv(): Record<string, string> {
  return process.env.PATH ? { PATH: process.env.PATH } : {};
}

function run(command: string, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: toolEnv() });
    let stdout = "";
    const tail: string[] = [];
    const errors: string[] = [];
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      // Only ffprobe's JSON comes here; keep it bounded anyway.
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) keep(line);
    });
    function keep(line: string) {
      if (!line) return;
      tail.push(line);
      if (tail.length > 200) tail.shift();
      // The level tag ffmpeg puts first (after an optional "[component @ 0x...]"), so text in
      // a file's own tags, such as a title "[error] ...", does not count.
      if (/^(\[[^\]]*\] )?\[(error|fatal|panic)\] /.test(line) && errors.length < 50) errors.push(line);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      keep(partial);
      resolve({ code, stdout, stderr: tail, errors });
    });
  });
}

/** What the file really is, read from its content (the temp file has no extension). */
export async function probe(tools: Tools, file: string, declared: AudioFormat): Promise<ProbeResult> {
  // ffmpeg's WAV and AIFF readers refuse a file without their header, but its FLAC reader skips
  // the first 4 bytes unchecked, so check FLAC's marker here.
  if (declared === "flac" && !(await startsWithFlacMarker(file))) return { ok: false, reason: "wrong_format" };
  const out = await run(tools.ffprobe ?? "ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_entries", "format=format_name:stream=codec_type,codec_name,sample_rate,channels,duration_ts,time_base",
    ...inputOptions(declared),
    file,
  ]);
  // ffprobe cannot open it as the declared format (empty, not audio, or another format such as
  // a playlist): not the declared format.
  if (out.code !== 0) return { ok: false, reason: "wrong_format" };
  let info: {
    format?: { format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; duration_ts?: number; time_base?: string }[];
  };
  try {
    info = JSON.parse(out.stdout);
  } catch {
    return { ok: false, reason: "wrong_format" };
  }
  const allowed = ALLOWED[declared];
  const containers = (info.format?.format_name ?? "").split(",");
  if (!containers.includes(allowed.container)) return { ok: false, reason: "wrong_format" };
  const audio = (info.streams ?? []).find((s) => s.codec_type === "audio");
  if (!audio) return { ok: false, reason: "no_audio" };
  if (!allowed.codec(audio.codec_name ?? "")) return { ok: false, reason: "wrong_format" };
  const sampleRateHz = Number(audio.sample_rate);
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) return { ok: false, reason: "unreadable" };

  // The length the header declares, in samples, when it declares one.
  let expectedSamples: number | null = null;
  const ts = Number(audio.duration_ts);
  const [num, den] = (audio.time_base ?? "").split("/").map(Number);
  if (Number.isFinite(ts) && ts > 0 && num > 0 && den > 0) {
    expectedSamples = Math.round((ts * num * sampleRateHz) / den);
  }
  // For WAV, ffprobe gives the length the file holds, not the one its header declares, so a
  // WAV cut short on a packet boundary would look whole. Read the header's own data size.
  if (declared === "wav") {
    const fromHeader = await wavDeclaredSamples(file);
    if (fromHeader !== null) expectedSamples = fromHeader;
  }
  return { ok: true, sampleRateHz, channels: Number(audio.channels) || 0, expectedSamples };
}

/**
 * Whether the file starts with "fLaC", after any ID3v2 tags (ffmpeg reads those before any
 * format, so a FLAC with one in front is still a FLAC).
 */
export async function startsWithFlacMarker(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    let position = 0;
    for (let n = 0; n < 10; n++) {
      const buffer = Buffer.alloc(10);
      const { bytesRead } = await handle.read(buffer, 0, 10, position);
      if (bytesRead >= 4 && buffer.toString("latin1", 0, 4) === "fLaC") return true;
      if (bytesRead < 10 || buffer.toString("latin1", 0, 3) !== "ID3") return false;
      // ID3v2: a 10-byte header, a size in 4 bytes of 7 bits each, and a 10-byte footer when flagged.
      if ((buffer[6] | buffer[7] | buffer[8] | buffer[9]) & 0x80) return false;
      const size = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
      position += 10 + size + (buffer[5] & 0x10 ? 10 : 0);
    }
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * The samples per channel a WAV's header declares: the `data` chunk's size (from `ds64` in an
 * RF64 file) over the block size in `fmt `. Null when the header doesn't say (a streamed WAV
 * with an unknown size) or can't be read; the decode checks still apply then.
 */
export async function wavDeclaredSamples(file: string): Promise<number | null> {
  const handle = await open(file, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const at = async (position: number, length: number): Promise<Buffer | null> => {
      if (position + length > fileSize) return null;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return bytesRead === length ? buffer : null;
    };
    const riff = await at(0, 12);
    if (!riff || riff.toString("latin1", 8, 12) !== "WAVE") return null;
    const kind = riff.toString("latin1", 0, 4);
    if (kind !== "RIFF" && kind !== "RF64") return null;
    let blockAlign = 0;
    let ds64DataSize: number | null = null;
    // Walk the chunks up to `data`. A few hundred is far more than any real file has.
    let position = 12;
    for (let n = 0; n < 1000; n++) {
      const header = await at(position, 8);
      if (!header) return null;
      const id = header.toString("latin1", 0, 4);
      const size = header.readUInt32LE(4);
      const bodyAt = position + 8;
      if (id === "fmt ") {
        const fmt = await at(bodyAt, 16);
        if (!fmt) return null;
        blockAlign = fmt.readUInt16LE(12);
      } else if (id === "ds64") {
        const ds64 = await at(bodyAt, 16);
        if (!ds64) return null;
        ds64DataSize = Number(ds64.readBigUInt64LE(8));
      } else if (id === "data") {
        let dataSize = size;
        if (kind === "RF64" && size === 0xffffffff) {
          if (ds64DataSize === null) return null;
          dataSize = ds64DataSize;
        } else if (size === 0xffffffff || size === 0) {
          // Unknown size (written while streaming).
          return null;
        }
        if (blockAlign <= 0) return null;
        return Math.floor(dataSize / blockAlign);
      }
      // Chunks are padded to an even size.
      position = bodyAt + size + (size % 2);
    }
    return null;
  } finally {
    await handle.close();
  }
}

export type TranscodeResult =
  | { ok: true; samples: number }
  | { ok: false; reason: "damaged" | "no_audio" | "unreadable"; detail: string };

/**
 * Decodes the whole master and writes the MP3. Fails when ffmpeg logs any error (a truncated
 * or corrupt file) or decodes fewer samples than the header declares. `samples` is the count
 * per channel at the master's own sample rate, for the duration.
 */
export async function transcode(
  tools: Tools,
  input: string,
  declared: AudioFormat,
  output: string,
  expectedSamples: number | null,
): Promise<TranscodeResult> {
  const out = await run(tools.ffmpeg ?? "ffmpeg", [
    "-nostdin", "-hide_banner", "-nostats",
    // Info level, so astats prints the sample count; each line is tagged with its level.
    "-loglevel", "level+info",
    "-xerror",
    ...inputOptions(declared),
    "-i", input,
    "-map", "0:a:0",
    "-vn",
    "-map_metadata", "-1",
    "-af", "astats=measure_perchannel=none:measure_overall=Number_of_samples",
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "libmp3lame",
    "-b:a", "320k",
    "-f", "mp3",
    "-y", output,
  ]);
  const detail = [...out.errors, ...out.stderr.slice(-5)].join("\n");
  if (out.code !== 0 || out.errors.length > 0) return { ok: false, reason: "damaged", detail };
  const counted = out.stderr
    .map((line) => /Number of samples:\s*(\d+)/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .pop();
  if (!counted) return { ok: false, reason: "unreadable", detail };
  const samples = Number(counted[1]);
  if (samples === 0) return { ok: false, reason: "no_audio", detail };
  if (expectedSamples !== null && samples < expectedSamples) {
    return { ok: false, reason: "damaged", detail: `decoded ${samples} of ${expectedSamples} samples\n${detail}` };
  }
  return { ok: true, samples };
}

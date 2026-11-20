// ffprobe and ffmpeg: check what a master really is, then decode it all the way through while
// making the streaming copy.
import { spawn } from "node:child_process";
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

function run(command: string, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      if (/\[(error|fatal|panic)\]/.test(line) && errors.length < 50) errors.push(line);
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
  const out = await run(tools.ffprobe ?? "ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_entries", "format=format_name:stream=codec_type,codec_name,sample_rate,channels,duration_ts,time_base",
    file,
  ]);
  // ffprobe cannot open it at all (empty, or not audio): not the declared format.
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
  return { ok: true, sampleRateHz, channels: Number(audio.channels) || 0, expectedSamples };
}

export type TranscodeResult =
  | { ok: true; samples: number }
  | { ok: false; reason: "damaged" | "no_audio" | "unreadable"; detail: string };

/**
 * Decodes the whole master and writes the MP3. Fails when ffmpeg logs any error (a truncated
 * or corrupt file) or decodes fewer samples than the header declares. `samples` is the count
 * per channel at the master's own sample rate, for the duration.
 */
export async function transcode(tools: Tools, input: string, output: string, expectedSamples: number | null): Promise<TranscodeResult> {
  const out = await run(tools.ffmpeg ?? "ffmpeg", [
    "-nostdin", "-hide_banner", "-nostats",
    // Info level, so astats prints the sample count; each line is tagged with its level.
    "-loglevel", "level+info",
    "-xerror",
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

/**
 * Streaming copies. Uncompressed audio (WAV, AIFF) and lossless FLAC are big:
 * a five-minute WAV is ~50 MB, the most the server accepts per file, and every
 * play costs bandwidth. Before uploading, those files — and anything over the
 * size limit — are converted to a high-quality MP3 (320 kbps when it fits).
 * MP3, M4A/AAC and OGG/Opus files under the limit upload untouched.
 */
import { MAX_UPLOAD_MB } from "../config";

const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const ALREADY_COMPRESSED = new Set(["mp3", "m4a", "aac", "mp4", "ogg", "oga", "opus"]);
const BITRATES = [320, 256, 192, 160, 128, 96];

export interface AudioFile { blob: Blob; ext: string; type: string }

export function needsStreamingCopy(file: AudioFile) {
  return !ALREADY_COMPRESSED.has(file.ext) || file.blob.size > MAX_BYTES * 0.97;
}

/** Highest bitrate whose MP3 fits under the limit, with a little room to spare. */
export function bitrateFor(seconds: number) {
  return BITRATES.find((k) => (seconds * k * 1000) / 8 < MAX_BYTES * 0.95) ?? null;
}

export async function prepareAudio(file: AudioFile, onProgress?: (pct: number) => void): Promise<AudioFile> {
  if (!needsStreamingCopy(file)) return file;

  let audio: AudioBuffer;
  try {
    // Decoding through a 44.1 kHz context also resamples 48/88.2/96 kHz masters.
    const ctx = new OfflineAudioContext(2, 1, 44100);
    audio = await ctx.decodeAudioData(await file.blob.arrayBuffer());
  } catch {
    if (file.blob.size <= MAX_BYTES) return file; // can't convert, but it fits: upload as-is
    throw new Error("Milk Crate couldn't read this file to shrink it. Export it as WAV, FLAC or MP3 and try again.");
  }

  const kbps = bitrateFor(audio.duration);
  if (!kbps) throw new Error(`This track is too long to upload (over ${Math.floor(audio.duration / 60)} minutes). Split it into parts.`);

  const left = audio.getChannelData(0).slice();
  const right = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice() : undefined;

  const chunks = await new Promise<Uint8Array[]>((resolve, reject) => {
    const worker = new Worker(new URL("./mp3.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.pct);
      else {
        worker.terminate();
        if (m.type === "done") resolve(m.chunks);
        else reject(new Error(`Couldn't convert the audio: ${m.message}`));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`Couldn't convert the audio: ${e.message || "converter failed to start"}`));
    };
    worker.postMessage({ left, right, sampleRate: audio.sampleRate, kbps }, right ? [left.buffer, right.buffer] : [left.buffer]);
  });

  return { blob: new Blob(chunks as BlobPart[], { type: "audio/mpeg" }), ext: "mp3", type: "audio/mpeg" };
}

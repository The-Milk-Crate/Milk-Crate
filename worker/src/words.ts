// What the artist reads when a track fails. One reason per release, in plain words.
import type { AudioFormat } from "./types.ts";

const FORMAT_NAMES: Record<AudioFormat, string> = { wav: "WAV", aiff: "AIFF", flac: "FLAC" };

export interface TrackLabel {
  position: number;
  title: string;
}

function label(track: TrackLabel): string {
  return `Track ${track.position}, "${track.title}"`;
}

export const words = {
  noMaster: (t: TrackLabel) => `${label(t)}: we could not find its uploaded file. Upload the master for this track again.`,
  shaMismatch: (t: TrackLabel) =>
    `${label(t)}: the file we received is not the one your app sent (its checksum does not match). Upload the master for this track again.`,
  wrongFormat: (t: TrackLabel, format: AudioFormat) =>
    `${label(t)}: this file is not a valid ${FORMAT_NAMES[format]}. Export it again and upload it.`,
  damaged: (t: TrackLabel) =>
    `${label(t)}: this file is damaged or incomplete, so it could not be read all the way through. Export it again and upload it.`,
  noAudio: (t: TrackLabel) => `${label(t)}: this file has no audio in it. Export it again and upload it.`,
  unreadable: (t: TrackLabel) =>
    `${label(t)}: we could not read this file's length or sample rate. Export it again and upload it.`,
  changed: "This release changed while it was being processed, so this result was not kept.",
} as const;

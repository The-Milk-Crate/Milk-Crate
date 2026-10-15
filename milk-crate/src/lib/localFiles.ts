import type { Track } from "./types";

/** True when running inside the Tauri desktop shell (vs. plain `npm run dev` in a browser). */
export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"];

function titleFromPath(path: string) {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
}

function toTrack(src: string, path: string): Track {
  return {
    id: `local:${path}`,
    releaseId: "local",
    artistId: "local",
    title: titleFromPath(path),
    duration: 0, // filled in once the audio element reads metadata
    src,
  };
}

/**
 * Let the listener pick audio files from their computer.
 * Desktop: native file dialog, files played through Tauri's asset protocol (paths survive restarts).
 * Browser dev mode: a file input with object URLs (only last for the session).
 */
export async function pickAudioFiles(): Promise<Track[]> {
  if (isDesktop()) {
    const [{ open }, { convertFileSrc }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/api/core"),
    ]);
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return paths.map((p) => toTrack(convertFileSrc(p), p));
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = AUDIO_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      resolve(files.map((f) => toTrack(URL.createObjectURL(f), f.name)));
    };
    input.click();
  });
}

/** Object URLs from browser dev mode don't survive a reload, so only desktop tracks are persisted. */
export const isPersistable = (track: Track) => !track.src?.startsWith("blob:");

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

/** Pick one cover image. Returns a URL the app can display, or null if cancelled. */
export async function pickImage(): Promise<string | null> {
  if (isDesktop()) {
    const [{ open }, { convertFileSrc }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/api/core"),
    ]);
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    return typeof picked === "string" ? convertFileSrc(picked) : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.onchange = () => {
      const f = input.files?.[0];
      resolve(f ? URL.createObjectURL(f) : null);
    };
    input.click();
  });
}

/** Reads an audio file's length in seconds (0 if it can't be read). */
export function readDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? Math.round(a.duration) : 0);
    a.onerror = () => resolve(0);
    a.src = src;
  });
}

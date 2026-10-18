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

/** Desktop: tracks for files already on this computer (e.g. a CD that was just ripped). */
export async function tracksFromPaths(paths: string[]): Promise<Track[]> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return paths.map((p) => toTrack(convertFileSrc(p), p));
}

const MIME: Record<string, string> = { mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg" };

/** True on a Mac, in the desktop app. */
const onMac = () => isDesktop() && /Mac/i.test(navigator.userAgent);
let mediaBase: Promise<string | null> | null = null;

/**
 * A URL the player can stream a song on this computer from. On a Mac it's the app's own local web
 * server (macOS's web view doesn't reliably play audio from the built-in file protocol); elsewhere
 * the file protocol URL the track already has.
 */
export async function playableSrc(track: { id: string; src?: string }, { raw = false } = {}): Promise<string | undefined> {
  if (!track.id.startsWith("local:") || !onMac()) return track.src;
  mediaBase ??= import("@tauri-apps/api/core").then(({ invoke }) => invoke<string>("media_base")).catch(() => null);
  const base = await mediaBase;
  if (!base) return track.src;
  const path = track.id.slice(6);
  // FLAC plays as WAV, decoded by the app: the Mac's web view may not play FLAC itself.
  // (`raw`: the file as it is, for reading its tags and cover.)
  const wav = !raw && /\.flac$/i.test(path);
  return `${base}${wav ? "wav/" : ""}${encodeURIComponent(path)}`;
}

/** Desktop: reads a song file through the app (not the webview) and returns a blob URL for it. */
export async function readLocalSong(path: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<ArrayBuffer>("read_audio_file", { path });
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "audio/*" }));
}

/** Desktop: fixes the header of FLAC files that some decoders refuse (see repair_flac_files). Returns the ones fixed. */
export async function repairFlacFiles(paths: string[]): Promise<string[]> {
  if (!isDesktop() || !paths.length) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("repair_flac_files", { paths }).catch(() => []);
}

/** Object URLs from browser dev mode don't survive a reload, so only desktop tracks are persisted. */
export const isPersistable = (track: Track) => !track.src?.startsWith("blob:");

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
export const FILE_KINDS = {
  image: { name: "Images", extensions: IMAGE_EXTENSIONS },
  /** Logos and lettering: transparent PNG or SVG work best. */
  logo: { name: "Logo or lettering", extensions: [...IMAGE_EXTENSIONS, "svg"] },
  font: { name: "Font files", extensions: ["ttf", "otf", "woff", "woff2"] },
} as const;

/** Pick one cover image. Returns a URL the app can display, or null if cancelled. */
export const pickImage = () => pickFile("image");

/**
 * Pick one file of a kind. Returns a URL the app can read, or null if cancelled.
 * In a browser the file name is kept after "#" so its type can be worked out later.
 */
export async function pickFile(kind: keyof typeof FILE_KINDS): Promise<string | null> {
  const { name, extensions } = FILE_KINDS[kind];
  if (isDesktop()) {
    const [{ open }, { convertFileSrc }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/api/core"),
    ]);
    const picked = await open({ multiple: false, directory: false, filters: [{ name, extensions: [...extensions] }] });
    return typeof picked === "string" ? convertFileSrc(picked) : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = extensions.map((e) => `.${e}`).join(",");
    input.onchange = () => {
      const f = input.files?.[0];
      resolve(f ? `${URL.createObjectURL(f)}#${encodeURIComponent(f.name)}` : null);
    };
    input.click();
  });
}

/** The file name at the end of a picked file's URL ("My Font.otf"). */
export const fileNameOf = (url: string) => decodeURIComponent(url.split(/[#/\\]|%2F|%5C/i).pop() ?? "").slice(0, 80);

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

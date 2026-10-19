/**
 * CD ripping (desktop app only): the app side of src-tauri/cdrip.
 * Find the CD, look it up on MusicBrainz, and save it as tagged FLAC files in
 * Music › Milk Crate › Artist › Album, then they show up in Your Computer.
 */
import { isDesktop } from "./localFiles";

export interface Disc {
  /** "D:" on Windows, the volume folder on a Mac. */
  id: string;
  label: string;
  discId: string;
  tracks: { number: number; seconds: number }[];
  seconds: number;
}

export interface CdMatch {
  releaseId: string;
  /** The album across all its pressings (so a CD and a record of it are one album). */
  releaseGroupId?: string | null;
  title: string;
  artist: string;
  year?: string | null;
  disc: number;
  discs: number;
  /** "CD · US · 2019 · Merge" */
  detail: string;
  tracks: { title: string; artist: string }[];
  exact: boolean;
}

export interface RipPlan {
  album: string;
  albumArtist: string;
  year?: string | null;
  releaseId?: string | null;
  releaseGroupId?: string | null;
  disc: number;
  discs: number;
  tracks: { number: number; title: string; artist: string }[];
  /** "data:image/jpeg;base64,…" */
  cover?: string | null;
}

export interface RipProgress {
  at: number;
  of: number;
  number: number;
  track: number;
  overall: number;
}

/** CD ripping needs the desktop app (it reads the drive directly). */
export const canRip = isDesktop;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** The CDs in the drives, and plain-words notes on drives that couldn't be used (no disc, no access…). */
export const findDiscs = () => call<{ discs: Disc[]; notes: string[] }>("cd_discs");
export const lookupDisc = (id: string) => call<CdMatch[]>("cd_lookup", { id });
export const fetchCover = (releaseId: string) => call<string | null>("cd_cover", { releaseId });
/** Stops the rip. `discard`: also delete the songs it already saved. */
export const cancelRip = (discard = false) => call<void>("cd_cancel", { discard });
export const ejectDisc = (id: string) => call<void>("cd_eject", { id });

/** Rips the disc; `onProgress` hears about each step. Returns the saved files, in track order. */
/** What a rip saved, and the songs it skipped because they couldn't be read (scratches, dirt). */
export interface Ripped {
  files: string[];
  skipped: { number: number; title: string; reason: string }[];
}

export async function ripDisc(id: string, plan: RipPlan, onProgress: (p: RipProgress) => void): Promise<Ripped> {
  const { listen } = await import("@tauri-apps/api/event");
  const stop = await listen<RipProgress>("cd-rip-progress", (e) => onProgress(e.payload));
  try {
    return await call<Ripped>("cd_rip", { id, plan });
  } finally {
    stop();
  }
}

/** A picture file the listener picked, as a data URL (JPEG or PNG only: those are what FLAC players show). */
export async function imageAsDataUrl(src: string): Promise<string | null> {
  const blob = src.startsWith("data:") ? dataUrlToBlob(src) : await (await fetch(src)).blob();
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const jpeg = head[0] === 0xff && head[1] === 0xd8;
  const png = head[0] === 0x89 && head[1] === 0x50;
  if (!jpeg && !png) return null;
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result.replace(/^data:[^;]*;/, `data:image/${jpeg ? "jpeg" : "png"};`) : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/**
 * A data: URL as a Blob, without fetch() (the desktop app's content security policy doesn't let
 * fetch read data: URLs, so that silently failed when changing a ripped CD's cover).
 */
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const head = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const type = head.split(";")[0] || "application/octet-stream";
  if (!/;base64$/i.test(head)) return new Blob([decodeURIComponent(body)], { type });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Where an album goes, for telling the listener (mirrors the Rust side's folder naming). */
export function albumFolder(artist: string, album: string) {
  const safe = (s: string, fallback: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "") || fallback;
  return `Music › Milk Crate › ${safe(artist, "Unknown Artist")} › ${safe(album, "Unknown Album")}`;
}

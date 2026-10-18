/**
 * Your Computer: audio files from this computer, sorted into albums and songs
 * by the tags inside the files (artist, album, track number, cover). The files
 * and their covers stay on this computer. Nothing here is uploaded or shared.
 */
import { useEffect, useState } from "react";
import type { FileTags, Track } from "./types";
import { load, save } from "./storage";

/* ---------- Which account's files ---------- */

const LEGACY = "mc.localTracks";
/** Where an account's list of files is kept on this computer. Signed out uses its own list. */
export const computerKey = (userId?: string) => (userId ? `${LEGACY}.${userId}` : LEGACY);

/**
 * The files list for an account on this computer. Each account on a computer has
 * its own; the first account to sign in takes the files that were added while signed out.
 */
export function loadComputerTracks(userId?: string): Track[] {
  if (!userId) return load<Track[]>(LEGACY, []);
  const mine = load<Track[] | null>(computerKey(userId), null);
  if (mine) return mine;
  const before = load<Track[]>(LEGACY, []);
  save(computerKey(userId), before);
  if (before.length) save(LEGACY, []);
  return before;
}

/* ---------- Reading a file's tags ---------- */

export interface ReadTags { title?: string; duration?: number; tags: FileTags; cover?: Blob }

/** Reads the tags inside an audio file (MP3, FLAC, M4A, OGG, WAV…). Never throws: a file without tags gives {}. */
export async function readFileTags(src: string): Promise<ReadTags> {
  try {
    const [{ parseBlob, selectCover }, res] = await Promise.all([import("music-metadata"), fetch(src)]);
    if (!res.ok) return { tags: {} };
    const meta = await parseBlob(await res.blob(), { duration: false, skipPostHeaders: true });
    const c = meta.common;
    const pic = selectCover(c.picture);
    const clean = (s?: string | null) => (s ?? "").replace(/\0/g, "").trim().slice(0, 200) || undefined;
    return {
      title: clean(c.title),
      duration: meta.format.duration ? Math.round(meta.format.duration) : undefined,
      tags: {
        artist: clean(c.artist),
        albumArtist: clean(c.albumartist),
        album: clean(c.album),
        trackNo: c.track?.no ?? undefined,
        discNo: c.disk?.no ?? undefined,
        year: c.year ?? undefined,
      },
      cover: pic ? new Blob([pic.data as BlobPart], { type: pic.format || "image/jpeg" }) : undefined,
    };
  } catch {
    return { tags: {} };
  }
}

/** Fills in a picked file's title, length, artist, album and cover from its tags. */
export async function tagTrack(t: Track): Promise<Track> {
  const r = await readFileTags(t.src ?? "");
  const tags: FileTags = { ...r.tags };
  if (r.cover) {
    const key = albumKey({ id: t.id, tags }) ?? `song:${t.id}`;
    const saved = await saveCover(key, r.cover).catch(() => false);
    if (saved) tags.cover = key;
  }
  // No tags at all: "Artist - Title.mp3" is a common way files are named.
  if (!r.title && !tags.artist) {
    const m = t.title.match(/^(.+?)\s+[-–]\s+(.+)$/);
    if (m) return { ...t, title: m[2].trim(), duration: r.duration ?? t.duration, tags: { ...tags, artist: m[1].trim() } };
  }
  return { ...t, title: r.title ?? t.title, duration: r.duration || t.duration, tags };
}

/* ---------- Grouping into albums ---------- */

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The album a file belongs to, or undefined for a file with no album tag.
 * Files in the same folder with the same album tag are one album even when each
 * song has a different artist (a compilation); an album artist tag also joins them.
 */
export function albumKey(t: Pick<Track, "id" | "tags">): string | undefined {
  const tags = t.tags;
  if (!tags?.album) return undefined;
  const path = t.id.replace(/^local:/, "");
  const folder = /[\\/]/.test(path) ? path.replace(/[\\/][^\\/]*$/, "") : "";
  const who = tags.albumArtist ? norm(tags.albumArtist) : folder ? `dir:${folder.toLowerCase()}` : norm(tags.artist);
  return `${who}|${norm(tags.album)}`;
}

/** Who made it, as the file says. */
export const fileArtist = (t: Track) => t.tags?.albumArtist || t.tags?.artist || "";

export interface ComputerAlbum {
  key: string;
  title: string;
  artist: string;
  year?: number;
  cover?: string;
  tracks: Track[];
}

/**
 * Albums (two or more files tagged with the same album) and loose songs.
 * Albums are sorted by artist then title; their songs by disc and track number.
 */
export function groupComputer(tracks: Track[]): { albums: ComputerAlbum[]; songs: Track[] } {
  const groups = new Map<string, Track[]>();
  const loose: Track[] = [];
  for (const t of tracks) {
    const k = albumKey(t);
    if (!k) loose.push(t);
    else groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const albums: ComputerAlbum[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) { loose.push(...list); continue; }
    const order = (t: Track) => (t.tags?.discNo ?? 1) * 1000 + (t.tags?.trackNo ?? 999);
    const sorted = [...list].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, undefined, { numeric: true }));
    const first = sorted[0].tags!;
    const artists = new Set(sorted.map((t) => norm(t.tags?.artist)).filter(Boolean));
    albums.push({
      key,
      title: first.album!,
      artist: first.albumArtist || (artists.size > 1 ? "Various artists" : first.artist || ""),
      year: sorted.find((t) => t.tags?.year)?.tags?.year,
      cover: sorted.find((t) => t.tags?.cover)?.tags?.cover,
      tracks: sorted,
    });
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  albums.sort((a, b) => byName(a.artist, b.artist) || byName(a.title, b.title));
  return { albums, songs: loose };
}

/* ---------- Covers, saved on this computer ---------- */

const DB = "milkcrate-covers";
const STORE = "covers";
const memo = new Map<string, string | null>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Shrinks a cover to a small JPEG (so hundreds of albums take a few MB) and saves it. */
async function saveCover(key: string, blob: Blob, replace = false): Promise<boolean> {
  if (memo.get(key) && !replace) return true;
  const bmp = await createImageBitmap(blob);
  const size = 320;
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const url = canvas.toDataURL("image/jpeg", 0.8);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(url, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  memo.set(key, url);
  return true;
}

/** A new picture for an album's cover in Your Computer; everything showing that cover updates. */
export async function replaceCover(key: string, blob: Blob) {
  await saveCover(key, blob, true);
  window.dispatchEvent(new CustomEvent("mc:cover", { detail: key }));
}

/** Forgets a saved cover (e.g. a playlist's own picture); everything showing it updates. */
export async function deleteCover(key: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  memo.set(key, null);
  window.dispatchEvent(new CustomEvent("mc:cover", { detail: key }));
}

export async function getCover(key: string): Promise<string | null> {
  if (memo.has(key)) return memo.get(key)!;
  try {
    const db = await openDb();
    const url = await new Promise<string | null>((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    });
    memo.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/** The saved cover for a file or album from your computer (undefined until it loads, or if there's none). */
export function useFileCover(key?: string): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => (key ? memo.get(key) ?? undefined : undefined));
  useEffect(() => {
    if (!key) { setUrl(undefined); return; }
    let live = true;
    const load = () => void getCover(key).then((u) => live && setUrl(u ?? undefined));
    load();
    const onChange = (e: Event) => { if ((e as CustomEvent<string>).detail === key) load(); };
    window.addEventListener("mc:cover", onChange);
    return () => { live = false; window.removeEventListener("mc:cover", onChange); };
  }, [key]);
  return url;
}

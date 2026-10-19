/**
 * CDs you ripped: they're albums in Your Computer (FLAC files on this computer) that also show
 * on Your Shelf (CDs) and in Your Crate › Albums. Only on this computer; nothing is uploaded or shared.
 */
import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "./player";
import { useLibrary } from "./library";
import { songKey } from "./songKeys";
import type { Track } from "./types";
import { albumKey, getCover, groupComputer, replaceCover, tagAll, type ComputerAlbum } from "./fileTags";
import { dataUrlToBlob, imageAsDataUrl } from "./cd";
import { isDesktop, pickImage, tracksFromPaths } from "./localFiles";

export interface RippedAlbum extends ComputerAlbum {
  /** When it was ripped (ms). */
  rippedAt: number;
}

/** Your ripped CDs that are still in Your Computer, newest first. */
export function useRippedAlbums(): RippedAlbum[] {
  const p = usePlayer();
  return useMemo(() => {
    if (!p.rippedCds.length) return [];
    const byKey = new Map(groupComputer(p.localTracks).albums.map((a) => [a.key, a]));
    return p.rippedCds.flatMap((r) => {
      const a = byKey.get(r.key);
      return a ? [{ ...a, rippedAt: r.at }] : [];
    });
  }, [p.rippedCds, p.localTracks]);
}

/** Covers for several Your Computer albums at once (key → image URL), filled in as they load. */
export function useFileCovers(keys: (string | undefined)[]): Record<string, string> {
  const [covers, setCovers] = useState<Record<string, string>>({});
  const joined = keys.filter(Boolean).join("\n");
  useEffect(() => {
    let live = true;
    const load = (key: string) => void getCover(key).then((url) => live && url && setCovers((c) => (c[key] === url ? c : { ...c, [key]: url })));
    const keys = joined ? joined.split("\n") : [];
    keys.forEach(load);
    const onChange = (e: Event) => { const k = (e as CustomEvent<string>).detail; if (keys.includes(k)) load(k); };
    window.addEventListener("mc:cover", onChange);
    return () => { live = false; window.removeEventListener("mc:cover", onChange); };
  }, [joined]);
  return covers;
}

/**
 * Pick a new picture for a ripped CD's cover. It's saved into the album's files (so other players
 * see it too) and everywhere Milk Crate shows the album. Returns an error to show, or null.
 */
export async function changeRippedCover(album: ComputerAlbum, updateTracks: (tracks: ComputerAlbum["tracks"]) => void): Promise<string | null> {
  try {
    return await setRippedCover(album, updateTracks);
  } catch (e) {
    return `Couldn't change the cover: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function setRippedCover(album: ComputerAlbum, updateTracks: (tracks: ComputerAlbum["tracks"]) => void): Promise<string | null> {
  const src = await pickImage();
  if (!src) return null;
  const url = await imageAsDataUrl(src).catch(() => null);
  if (!url) return "That picture needs to be a JPEG or PNG.";
  if (isDesktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const files = album.tracks.map((t) => t.id.replace(/^local:/, ""));
    try {
      await invoke("cd_set_cover", { files, cover: url });
    } catch (e) {
      return String(e);
    }
  }
  const key = album.cover ?? album.key;
  try {
    await replaceCover(key, dataUrlToBlob(url));
  } catch {
    return "The picture was saved into the album's files, but Milk Crate couldn't show it. Try a different picture.";
  }
  // An album that had no cover: its songs now point at the new one.
  if (!album.cover) updateTracks(album.tracks.map((t) => ({ ...t, tags: { ...t.tags, cover: key } })));
  return null;
}

/** Ids of every song from a CD you ripped (for the "on this computer" mark next to them). */
export function useRippedTrackIds(): Set<string> {
  const ripped = useRippedAlbums();
  return useMemo(() => new Set(ripped.flatMap((a) => a.tracks.map((t) => t.id))), [ripped]);
}

/**
 * Adds a just-ripped CD's files: they join Your Computer (tags and cover read from the files),
 * and the CD goes on Your Shelf and in Your Crate › Albums (on this computer only).
 * Returns the album's key. Used by the CD ripper wherever it's open.
 */
export function useAddRipped() {
  const p = usePlayer();
  return async (paths: string[]): Promise<string | undefined> => {
    const tracks = await tracksFromPaths(paths);
    // Ripping the same CD again: refresh what's there instead of adding duplicates.
    const known = new Set(tracks.map((t) => t.id));
    p.localTracks.filter((t) => known.has(t.id)).forEach((t) => p.removeLocalTrack(t.id));
    const tagged = await tagAll(tracks, () => {});
    p.addLocalTracks(tagged);
    const key = tagged.map(albumKey).find(Boolean);
    if (key) p.addRippedCd(key);
    return key;
  };
}

export interface RippedEdit {
  /** The album's new title. */
  album: string;
  /** Four digits, or "" for none. */
  year: string;
  /** New song titles, by song id. */
  titles: Record<string, string>;
}

/**
 * Change a ripped CD's album title, year and song titles. Saved into its FLAC files (so other
 * players, and your other computers when you send it again, see them too); its playlists and
 * favorites follow. Returns the album's key afterward (it changes with the title), or throws.
 */
export function useEditRipped() {
  const p = usePlayer();
  const lib = useLibrary();
  return async (album: ComputerAlbum, edit: RippedEdit): Promise<string> => {
    const albumTitle = edit.album.trim();
    const year = edit.year.trim();
    if (!albumTitle) throw new Error("Give the album a title.");
    if (year && !/^\d{4}$/.test(year)) throw new Error("The year needs to be four digits, like 1995.");
    const next: Track[] = album.tracks.map((t) => ({
      ...t,
      title: (edit.titles[t.id] ?? t.title).trim() || t.title,
      tags: { ...t.tags, album: albumTitle, year: year ? Number(year) : undefined },
    }));
    if (isDesktop()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const edits = next.map((t, i) => ({
        file: t.id.replace(/^local:/, ""),
        title: t.title !== album.tracks[i].title ? t.title : null,
        album: albumTitle !== album.title ? albumTitle : null,
        year: String(album.year ?? "") !== year ? year : null,
      })).filter((e) => e.title !== null || e.album !== null || e.year !== null);
      if (edits.length) await invoke("cd_set_tags", { edits }).catch((e) => { throw new Error(String(e)); });
    }
    // Playlists and favorites kept with your account describe songs by these details: they follow.
    const keys: Record<string, string> = {};
    album.tracks.forEach((t, i) => { keys[songKey(t)] = songKey(next[i]); });
    p.updateLocalTracks(next);
    const newKey = albumKey(next[0]) ?? album.key;
    if (newKey !== album.key) p.renameRippedCd(album.key, newKey);
    void lib.renameSongKeys(keys);
    return newKey;
  };
}

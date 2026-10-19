/**
 * CDs you ripped: they're albums in Your Computer (FLAC files on this computer) that also show
 * on Your Shelf (CDs) and in Your Crate › Albums. Only on this computer; nothing is uploaded or shared.
 */
import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "./player";
import { useLibrary } from "./library";
import { songKey } from "./songKeys";
import type { Track } from "./types";
import { albumKey, getCover, groupComputer, isVinyl, replaceCover, tagAll, type ComputerAlbum } from "./fileTags";
import { useSyncExternalStore } from "react";
import { load, save } from "./storage";
import { dataUrlToBlob, imageAsDataUrl } from "./cd";
import { isDesktop, pickImage, tracksFromPaths } from "./localFiles";

export type RipFormat = "CD" | "Vinyl";

export interface RippedAlbum extends ComputerAlbum {
  /** When it was ripped (ms). */
  rippedAt: number;
  /** Ripped from a CD or a record. */
  format: RipFormat;
  /** The same album whatever it was ripped from (see copyKeyOf). */
  copyKey: string;
  /** Every copy you ripped of this album (this one included): a CD and a record of it, say. */
  copies: RippedAlbum[];
}

const normName = (s?: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
/** One album however it was ripped: the same artist and title, or the same MusicBrainz album (see linkCopies). */
export function copyKeyOf(a: ComputerAlbum): string {
  return `${normName(a.artist)}|${normName(a.title)}`;
}
const groupOf = (a: ComputerAlbum) => a.tracks.find((t) => t.tags?.releaseGroup)?.tags?.releaseGroup;

/** Copies with different titles ("Ten" and "Ten (Remastered)") that MusicBrainz says are one album share a key. */
function linkCopies(list: RippedAlbum[]) {
  const byGroup = new Map<string, string>();
  for (const a of list) {
    const g = groupOf(a);
    if (!g) continue;
    const known = byGroup.get(g);
    if (known) {
      const old = a.copyKey;
      for (const x of list) if (x.copyKey === old) x.copyKey = known;
    } else byGroup.set(g, a.copyKey);
  }
}

/** Your ripped CDs and records that are still in Your Computer, newest first: each copy separately (Your Shelf). */
export function useRippedAlbums(): RippedAlbum[] {
  const p = usePlayer();
  return useMemo(() => {
    if (!p.rippedCds.length) return [];
    const byKey = new Map(groupComputer(p.localTracks).albums.map((a) => [a.key, a]));
    const list: RippedAlbum[] = p.rippedCds.flatMap((r) => {
      const a = byKey.get(r.key);
      return a ? [{ ...a, rippedAt: r.at, format: r.format ?? "CD", copyKey: copyKeyOf(a), copies: [] as RippedAlbum[] }] : [];
    });
    linkCopies(list);
    const groups = new Map<string, RippedAlbum[]>();
    for (const a of list) groups.set(a.copyKey, [...(groups.get(a.copyKey) ?? []), a]);
    for (const a of list) a.copies = groups.get(a.copyKey)!;
    return list;
  }, [p.rippedCds, p.localTracks]);
}

/* Which copy to play when you have an album on both CD and vinyl: the one you last picked, vinyl until you pick. */
const PREF_KEY = "mc.copyPref";
let prefs = load<Record<string, RipFormat>>(PREF_KEY, {});
const prefListeners = new Set<() => void>();
export function setCopyPref(copyKey: string, format: RipFormat) {
  prefs = { ...prefs, [copyKey]: format };
  save(PREF_KEY, prefs);
  prefListeners.forEach((l) => l());
}
export function useCopyPrefs(): Record<string, RipFormat> {
  return useSyncExternalStore((l) => { prefListeners.add(l); return () => prefListeners.delete(l); }, () => prefs);
}
/** The copy to play out of an album's copies. */
export function preferredCopy(copies: RippedAlbum[], pref?: RipFormat): RippedAlbum {
  return copies.find((c) => c.format === pref) ?? copies.find((c) => c.format === "Vinyl") ?? copies[0];
}

/**
 * Your ripped albums for Your Crate, Home and search: each album once, as the copy you play
 * (when you have it on both CD and vinyl). Your Shelf keeps both (useRippedAlbums).
 */
export function useRippedForCrate(): RippedAlbum[] {
  const all = useRippedAlbums();
  const pref = useCopyPrefs();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: RippedAlbum[] = [];
    for (const a of all) {
      if (seen.has(a.copyKey)) continue;
      seen.add(a.copyKey);
      out.push(preferredCopy(a.copies, pref[a.copyKey]));
    }
    return out;
  }, [all, pref]);
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
  return async (paths: string[], format?: RipFormat): Promise<string | undefined> => {
    const tracks = await tracksFromPaths(paths);
    // Ripping the same CD again: refresh what's there instead of adding duplicates.
    const known = new Set(tracks.map((t) => t.id));
    p.localTracks.filter((t) => known.has(t.id)).forEach((t) => p.removeLocalTrack(t.id));
    const tagged = await tagAll(tracks, () => {});
    p.addLocalTracks(tagged);
    const key = tagged.map(albumKey).find(Boolean);
    // Sent from your other computer: the files say whether they came off a record.
    if (key) p.addRippedCd(key, format ?? (tagged.some((t) => isVinyl(t.tags?.media)) ? "Vinyl" : "CD"));
    return key;
  };
}

export interface RippedEdit {
  /** The album's new title. */
  album: string;
  /** The album's artist. */
  artist: string;
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
    const artist = edit.artist.trim();
    const year = edit.year.trim();
    if (!albumTitle) throw new Error("Give the album a title.");
    if (!artist) throw new Error("Give the album an artist.");
    const oldArtist = album.artist;
    const artistChanged = artist !== oldArtist;
    // Songs credited to the album's artist follow the new name; a guest's or a compilation's own artist stays.
    const sameArtist = (t: Track) => !t.tags?.artist || t.tags.artist === oldArtist || t.tags.artist === t.tags.albumArtist;
    if (year && !/^\d{4}$/.test(year)) throw new Error("The year needs to be four digits, like 1995.");
    const next: Track[] = album.tracks.map((t) => ({
      ...t,
      title: (edit.titles[t.id] ?? t.title).trim() || t.title,
      tags: {
        ...t.tags, album: albumTitle, year: year ? Number(year) : undefined,
        ...(artistChanged ? { albumArtist: artist, artist: sameArtist(t) ? artist : t.tags?.artist } : {}),
      },
    }));
    if (isDesktop()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const edits = next.map((t, i) => ({
        file: t.id.replace(/^local:/, ""),
        title: t.title !== album.tracks[i].title ? t.title : null,
        album: albumTitle !== album.title ? albumTitle : null,
        year: String(album.year ?? "") !== year ? year : null,
        albumArtist: artistChanged ? artist : null,
        artist: artistChanged && sameArtist(album.tracks[i]) ? artist : null,
      })).filter((e) => e.title !== null || e.album !== null || e.year !== null || e.albumArtist !== null);
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

/** The sticker for a ripped album: "CD", "VINYL", or "CD · VINYL" when you have both. */
export function copyLabel(a: RippedAlbum): string {
  const has = new Set(a.copies.map((c) => c.format));
  return [has.has("CD") && "CD", has.has("Vinyl") && "VINYL"].filter(Boolean).join(" · ") || "CD";
}

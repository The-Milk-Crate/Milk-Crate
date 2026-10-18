/**
 * CDs you ripped: they're albums in Your Computer (FLAC files on this computer) that also show
 * on Your Shelf (CDs) and in Your Crate › Albums. Only on this computer; nothing is uploaded or shared.
 */
import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "./player";
import { getCover, groupComputer, replaceCover, type ComputerAlbum } from "./fileTags";
import { dataUrlToBlob, imageAsDataUrl } from "./cd";
import { isDesktop, pickImage } from "./localFiles";

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

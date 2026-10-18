/**
 * CDs you ripped: they're albums in Your Computer (FLAC files on this computer) that also show
 * on Your Shelf (CDs) and in Your Crate › Albums. Only on this computer; nothing is uploaded or shared.
 */
import { useEffect, useMemo, useState } from "react";
import { usePlayer } from "./player";
import { getCover, groupComputer, type ComputerAlbum } from "./fileTags";

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
    for (const key of joined ? joined.split("\n") : []) {
      void getCover(key).then((url) => live && url && setCovers((c) => (c[key] === url ? c : { ...c, [key]: url })));
    }
    return () => { live = false; };
  }, [joined]);
  return covers;
}

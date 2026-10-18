/**
 * Songs from your computers (ripped CDs, your own files) described the same way on every
 * computer: "song:<artist>|<album>|<disc>|<track>|<title>" from the file's tags. Playlists and
 * favorites keep that description with your account, so another computer of yours with the same
 * CD finds its own copy. Only the description is saved; the music stays on each computer.
 */
import { useSyncExternalStore } from "react";
import type { Track } from "./types";

const norm = (s?: string) => (s ?? "").toLowerCase().normalize("NFC").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
const fileName = (id: string) => (id.replace(/^local:/, "").split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");

export const isSongKey = (id: string) => id.startsWith("song:");

/** The description of a song from this computer. */
export function songKey(t: Pick<Track, "id" | "title" | "tags">): string {
  const tags = t.tags ?? {};
  const title = norm(t.title) || norm(fileName(t.id));
  return `song:${norm(tags.albumArtist || tags.artist)}|${norm(tags.album)}|${tags.discNo ?? 1}|${tags.trackNo ?? 0}|${title}`.slice(0, 600);
}

// This computer's songs, both ways: "local:<path>" ↔ "song:…".
let byId = new Map<string, string>();
let byKey = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();

/** Called by the player whenever this computer's songs change. */
export function setComputerSongs(tracks: Track[]) {
  const ids = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const t of tracks) {
    if (!t.id.startsWith("local:")) continue;
    const k = songKey(t);
    ids.set(t.id, k);
    if (!keys.has(k)) keys.set(k, t.id);
  }
  const same = ids.size === byId.size && [...ids].every(([id, k]) => byId.get(id) === k);
  if (same) return;
  byId = ids;
  byKey = keys;
  version++;
  listeners.forEach((l) => l());
}

/** The description of one of this computer's songs (other ids come back as they are). */
export const toPortable = (id: string) => byId.get(id) ?? id;
/** This computer's copy of a described song, or the description when this computer doesn't have it. */
export const fromPortable = (id: string) => (isSongKey(id) ? byKey.get(id) ?? id : id);

/** Re-renders when this computer's songs change. */
export function useComputerSongsVersion() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}

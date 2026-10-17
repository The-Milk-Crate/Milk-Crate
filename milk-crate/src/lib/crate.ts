/**
 * How Your Crate is organized. Everything you've added from one release is one
 * entry. 1, 2 or 3 songs: a single, double or triple (under Singles). 4 or more
 * songs, or a whole album or EP: an album (under Albums). A whole single goes
 * under Singles (as a double or triple if it has 2 or 3 songs).
 */
import type { Play } from "./history";
import type { Release } from "./types";

export type CrateKind = "album" | "single" | "double" | "triple";
export const KIND_LABEL: Record<CrateKind, string> = { album: "Album", single: "Single", double: "Double", triple: "Triple" };

export interface CrateEntry {
  release: Release;
  /** The songs from it that are in your crate, in the release's order. */
  trackIds: string[];
  /** The whole release is in your crate. */
  whole: boolean;
  kind: CrateKind;
  /** When you added it (the latest addition). */
  addedAt: number;
  /** When you last played a song from it (0 = never). */
  playedAt: number;
}

export function kindFor(count: number): CrateKind {
  return count >= 4 ? "album" : count === 3 ? "triple" : count === 2 ? "double" : "single";
}

export function buildCrate(
  saved: { releaseId: string; addedAt: string }[],
  songs: { trackId: string; addedAt: string }[],
  releaseById: Record<string, Release>,
  trackRelease: (trackId: string) => string | undefined,
  history: Play[] = [],
): CrateEntry[] {
  const entries = new Map<string, CrateEntry>();
  const at = (iso: string) => Date.parse(iso) || 0;
  for (const s of saved) {
    const release = releaseById[s.releaseId];
    if (!release) continue;
    entries.set(release.id, { release, trackIds: [...release.trackIds], whole: true, kind: "album", addedAt: at(s.addedAt), playedAt: 0 });
  }
  for (const s of songs) {
    const releaseId = trackRelease(s.trackId);
    const release = releaseId ? releaseById[releaseId] : undefined;
    if (!release) continue;
    const e = entries.get(release.id) ?? { release, trackIds: [], whole: false, kind: "single" as CrateKind, addedAt: 0, playedAt: 0 };
    if (!e.trackIds.includes(s.trackId)) e.trackIds.push(s.trackId);
    e.addedAt = Math.max(e.addedAt, at(s.addedAt));
    entries.set(release.id, e);
  }
  const lastPlayed = new Map<string, number>();
  for (const h of history) if (h.at > (lastPlayed.get(h.releaseId) ?? 0)) lastPlayed.set(h.releaseId, h.at);
  for (const e of entries.values()) {
    const order = e.release.trackIds;
    e.trackIds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    // A whole album or EP is an album, however many songs it has. A whole single goes by its songs
    // (a single that's coming soon has none to count yet: it's a single).
    e.kind = e.whole && e.release.kind !== "Single" ? "album" : kindFor(Math.min(e.whole ? 3 : 99, e.trackIds.length || 1));
    e.playedAt = lastPlayed.get(e.release.id) ?? 0;
  }
  return [...entries.values()];
}

/** Most recently played first; ones you haven't played yet follow, newest added first. */
export const byRecentlyPlayed = (a: CrateEntry, b: CrateEntry) => b.playedAt - a.playedAt || b.addedAt - a.addedAt;

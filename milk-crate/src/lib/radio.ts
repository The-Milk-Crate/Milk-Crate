/**
 * Scene radio: nonstop music from a scene. Each batch mixes the scene's songs,
 * leaning toward your favorites, newer releases, well-streamed songs and bands
 * you haven't heard yet, without the same band twice in a row or songs you've
 * just heard. (Weights only nudge: every song in the scene can come up.)
 */
import { weightedShuffle } from "./shuffle";
import { outAt, type Release, type Track } from "./types";

const DAY = 86_400_000;

export interface RadioInput {
  /** Every song that could play (already limited to the scene's artists). */
  tracks: Track[];
  releaseById: Record<string, Release>;
  streams: Record<string, number>;
  favorites: Set<string>;
  /** Recently played song ids, newest first (used to find bands you haven't heard). */
  history: string[];
  /** Songs not to play in this batch (just heard, or already in the queue). */
  exclude: Set<string>;
  /** The band that played last, so the batch doesn't start with them again. */
  lastArtist?: string;
  count?: number;
  now?: number;
  random?: () => number;
}

/** How strongly a song is pulled toward the front of the radio. */
export function radioWeight(t: Track, i: Pick<RadioInput, "releaseById" | "streams" | "favorites">, heardArtists: Set<string>, now: number) {
  let w = 1;
  if (i.favorites.has(t.id)) w *= 2.2;
  const r = i.releaseById[t.releaseId];
  const age = r ? now - outAt(r) : Infinity;
  if (age < 30 * DAY) w *= 1.8;
  else if (age < 90 * DAY) w *= 1.3;
  w *= 1 + 0.12 * Math.log10(1 + (i.streams[t.id] ?? 0));
  if (!heardArtists.has(t.artistId)) w *= 1.5;
  return w;
}

/**
 * Keeps the order as close as it can while spacing bands out: never the same
 * band twice in a row when there's any other choice, and a band with lots of
 * songs is worked in early rather than piling up at the end.
 */
export function spreadArtists(order: Track[], lastArtist?: string): Track[] {
  const rest = [...order];
  const out: Track[] = [];
  let prev = lastArtist;
  while (rest.length) {
    const counts = new Map<string, number>();
    for (const t of rest) counts.set(t.artistId, (counts.get(t.artistId) ?? 0) + 1);
    // A band that has more than half of what's left has to come up now (unless it just played).
    const crowded = [...counts].find(([a, n]) => a !== prev && n > Math.ceil(rest.length / 2))?.[0];
    let i = crowded ? rest.findIndex((t) => t.artistId === crowded) : rest.findIndex((t) => t.artistId !== prev);
    if (i < 0) i = 0;
    const [t] = rest.splice(i, 1);
    out.push(t);
    prev = t.artistId;
  }
  return out;
}

/** The next batch of songs for the radio. Never empty while the scene has any songs. */
export function radioBatch(input: RadioInput): Track[] {
  const { tracks, exclude, count = 25, now = Date.now(), random = Math.random } = input;
  if (!tracks.length) return [];
  const heard = new Set(input.history.map((id) => tracks.find((t) => t.id === id)?.artistId).filter(Boolean) as string[]);
  // Small scenes run out of fresh songs: then only the last few heard are held back.
  let pool = tracks.filter((t) => !exclude.has(t.id));
  if (pool.length < Math.min(5, tracks.length)) {
    const lastFew = new Set(input.history.slice(0, Math.max(1, Math.floor(tracks.length / 3))));
    pool = tracks.filter((t) => !lastFew.has(t.id));
    if (!pool.length) pool = tracks;
  }
  const order = weightedShuffle(pool, (t) => radioWeight(t, input, heard, now), random);
  return spreadArtists(order, input.lastArtist).slice(0, count);
}

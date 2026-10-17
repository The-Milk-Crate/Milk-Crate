/**
 * Crate dividers for Scenes: a scene's towns as record-store bins.
 *
 * Every town in the scene where a band has released music gets a bin, nearest
 * first. The town the scene is centered on always comes first, even when its
 * bin is empty (your own town, or the town you're looking around). Each bin
 * holds that town's artists and their releases, newest first.
 */
import { inScene, miles, placeKey, type Place, type Scene } from "./geo";
import type { Release } from "./types";
import type { ArtistPlace } from "./location";

/** A release counts as new for this long after it goes up. */
export const NEW_FOR_DAYS = 7;

export interface Bin {
  key: string;
  place: Place;
  /** Miles from the scene's center town. */
  miles: number;
  /** The town the scene is centered on. */
  isCenter: boolean;
  artists: ArtistPlace[];
  /** Newest first. */
  releases: Release[];
  /** Something went up in this bin in the last NEW_FOR_DAYS days. */
  isNew: boolean;
}

const addedTime = (r: Release) => (r.addedAt ? Date.parse(r.addedAt) || 0 : 0);

export function buildBins(scene: Scene, placed: ArtistPlace[], releases: Release[], now = Date.now()): Bin[] {
  const center = scene.home;
  const groups = new Map<string, { place: Place; artists: ArtistPlace[] }>();
  groups.set(placeKey(center), { place: center, artists: [] });
  for (const a of placed) {
    if (!inScene(scene, a.place)) continue;
    const k = placeKey(a.place);
    const g = groups.get(k) ?? { place: a.place, artists: [] };
    g.artists.push(a);
    groups.set(k, g);
  }
  const byArtist = new Map<string, Release[]>();
  for (const r of releases) byArtist.set(r.artistId, [...(byArtist.get(r.artistId) ?? []), r]);
  const fresh = now - NEW_FOR_DAYS * 86_400_000;

  return [...groups.entries()]
    .map(([key, g]) => {
      const rel = g.artists
        .flatMap((a) => byArtist.get(a.artist.id) ?? [])
        .sort((a, b) => addedTime(b) - addedTime(a) || b.year - a.year);
      return {
        key,
        place: g.place,
        miles: key === placeKey(center) ? 0 : miles(center, g.place),
        isCenter: key === placeKey(center),
        artists: [...g.artists].sort((a, b) => a.artist.name.localeCompare(b.artist.name)),
        releases: rel,
        isNew: rel.some((r) => addedTime(r) >= fresh),
      };
    })
    .sort((a, b) => Number(b.isCenter) - Number(a.isCenter) || a.miles - b.miles);
}

/** "9 mi", "140 mi" (never "0 mi"). */
export const milesLabel = (m: number) => `${Math.max(1, Math.round(m))} mi`;

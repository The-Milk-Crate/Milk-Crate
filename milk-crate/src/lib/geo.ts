/**
 * Real places and scenes.
 *
 * Cities come from public/cities-us.json (GeoNames: every US city and town
 * with 1,000+ people). A listener's scene is built around their home city:
 * the cities within SCENE_RADIUS_MI of it, plus the larger cities in their
 * state (and the towns right around those).
 */
import { useEffect, useState } from "react";

export interface Place { name: string; state: string; lat: number; lng: number; pop: number }
export interface Point { lat: number; lng: number }

export const SCENE_RADIUS_MI = 35;
/** Artists this close to one of the state's larger cities count as part of it. */
export const ANCHOR_RADIUS_MI = 15;
const ANCHOR_MIN_POP = 100_000;
/** Every state gets at least this many larger cities, even small ones. */
const ANCHOR_MIN_COUNT = 3;

export const placeLabel = (p: { name: string; state: string }) => `${p.name}, ${p.state}`;
export const placeKey = (p: { name: string; state: string }) => `${p.name}|${p.state}`.toLowerCase();

/* ---------- loading ---------- */

let loading: Promise<Place[]> | null = null;

export function loadPlaces(): Promise<Place[]> {
  if (!loading) {
    loading = fetch("/cities-us.json")
      .then((r) => {
        if (!r.ok) throw new Error(`cities ${r.status}`);
        return r.json();
      })
      .then((d: { cities: [string, string, number, number, number][] }) =>
        d.cities.map(([name, state, lat, lng, pop]) => ({ name, state, lat, lng, pop })),
      )
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export function usePlaces(): Place[] | null {
  const [places, setPlaces] = useState<Place[] | null>(null);
  useEffect(() => {
    let live = true;
    loadPlaces().then((p) => live && setPlaces(p)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return places;
}

/* ---------- search ---------- */

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^saint\b/, "st").replace(/[^a-z0-9 ]/g, "").trim();

/** City search for the picker: "rale", "raleigh nc", "portland, me". Biggest places first. */
export function searchPlaces(places: Place[], query: string, limit = 8): Place[] {
  const raw = query.trim();
  if (!raw) return [];
  let [namePart, statePart] = raw.includes(",") ? raw.split(",", 2) : [raw, ""];
  const m = !statePart && /^(.*\S)\s+([A-Za-z]{2})$/.exec(namePart);
  if (m && STATE_NAMES[m[2].toUpperCase()]) [namePart, statePart] = [m[1], m[2]];
  const q = fold(namePart);
  const st = statePart.trim().toUpperCase();
  if (!q) return [];
  const starts: Place[] = [];
  const contains: Place[] = [];
  for (const p of places) {
    if (st && !p.state.startsWith(st) && !fold(STATE_NAMES[p.state] ?? "").startsWith(fold(statePart))) continue;
    const n = fold(p.name);
    if (n.startsWith(q)) starts.push(p);
    else if (q.length > 2 && n.includes(q)) contains.push(p);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

export function findPlace(places: Place[], name: string, state: string): Place | undefined {
  const key = placeKey({ name, state });
  return places.find((p) => placeKey(p) === key);
}

/** "Durham, NC" → the place, for profiles saved before locations had coordinates. */
export function placeFromLabel(places: Place[], label: string): Place | undefined {
  const [name, state] = label.split(",").map((s) => s.trim());
  return name && state ? findPlace(places, name, state) : undefined;
}

/* ---------- distance and scenes ---------- */

export function miles(a: Point, b: Point): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Scene {
  home: Place;
  /** Cities within SCENE_RADIUS_MI of home (not including home), biggest first. */
  nearby: Place[];
  /** Larger cities elsewhere in the home state. */
  anchors: Place[];
}

export function sceneFor(home: Place, places: Place[]): Scene {
  const nearby = places.filter((p) => placeKey(p) !== placeKey(home) && miles(home, p) <= SCENE_RADIUS_MI);
  const inState = places.filter((p) => p.state === home.state);
  const anchors = inState
    .filter((p, i) => p.pop >= ANCHOR_MIN_POP || i < ANCHOR_MIN_COUNT)
    .filter((p) => placeKey(p) !== placeKey(home) && miles(home, p) > SCENE_RADIUS_MI);
  return { home, nearby, anchors };
}

/** Is this point part of the scene? */
export function inScene(scene: Scene, pt: Point): boolean {
  if (miles(scene.home, pt) <= SCENE_RADIUS_MI) return true;
  return scene.anchors.some((a) => miles(a, pt) <= ANCHOR_RADIUS_MI);
}

/** "Durham, Cary and Chapel Hill nearby, plus Charlotte and Greensboro" */
export function sceneSummary(scene: Scene, max = 3): string {
  const list = (ps: Place[]) => {
    const names = ps.slice(0, max).map((p) => p.name);
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
  };
  const parts = [];
  if (scene.nearby.length) parts.push(`${list(scene.nearby)} nearby`);
  if (scene.anchors.length) parts.push(`${parts.length ? "plus " : ""}${list(scene.anchors)}`);
  return parts.join(", ");
}

/* ---------- states ---------- */

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/**
 * Real places and scenes.
 *
 * Cities come from public/cities-us.json, cities-ca.json and cities-au.json
 * (GeoNames: every city and town with 1,000+ people in the United States,
 * Canada and Australia). A listener's scene is built around their home city:
 * the cities within SCENE_RADIUS_MI of it (across a border too), plus the
 * larger cities in their state or province (and the towns right around those).
 */
import { useEffect, useState } from "react";

/** The countries Milk Crate covers. */
export type Country = "US" | "CA" | "AU";
export const COUNTRIES: Country[] = ["US", "CA", "AU"];
export const COUNTRY_NAMES: Record<Country, string> = { US: "United States", CA: "Canada", AU: "Australia" };
export const isCountry = (c: unknown): c is Country => c === "US" || c === "CA" || c === "AU";

/** `state` is the state, province or territory code: NC, ON, NSW. */
export interface Place { name: string; state: string; country: Country; lat: number; lng: number; pop: number }
export interface Point { lat: number; lng: number }

export const SCENE_RADIUS_MI = 35;
/** Artists this close to one of the state's larger cities count as part of it. */
export const ANCHOR_RADIUS_MI = 15;
const ANCHOR_MIN_POP = 100_000;
/** Every state gets at least this many larger cities, even small ones. */
const ANCHOR_MIN_COUNT = 3;

export const placeLabel = (p: { name: string; state: string }) => `${p.name}, ${p.state}`;
/** A town's id. US towns keep the key they always had. */
export const placeKey = (p: { name: string; state: string; country?: Country }) =>
  (p.country && p.country !== "US" ? `${p.name}|${p.state}|${p.country}` : `${p.name}|${p.state}`).toLowerCase();

/** "North Carolina", "Ontario", "New South Wales". */
export const regionName = (p: { state: string; country?: Country }) => REGION_NAMES[p.country ?? "US"][p.state] ?? p.state;
/** "North Carolina" in the US; "Ontario, Canada" elsewhere (for lists that mix countries). */
export const regionAndCountry = (p: { state: string; country?: Country }) =>
  !p.country || p.country === "US" ? regionName(p) : `${regionName(p)}, ${COUNTRY_NAMES[p.country]}`;
/** "Toronto, ON" with the country added when it isn't the one you're in: "Perth, WA, Australia". */
export const placeLabelFrom = (p: { name: string; state: string; country?: Country }, mine?: Country) =>
  (p.country ?? "US") === (mine ?? "US") ? placeLabel(p) : `${placeLabel(p)}, ${COUNTRY_NAMES[p.country ?? "US"]}`;

/* ---------- distance units ---------- */

/** Miles in the US, kilometres in Canada and Australia. */
export type Units = "mi" | "km";
export const unitsFor = (c?: Country | null): Units => (c && c !== "US" ? "km" : "mi");
/** "9 mi" / "14 km" (never 0). */
export const distanceLabel = (mi: number, units: Units = "mi") =>
  units === "km" ? `${Math.max(1, Math.round(mi * 1.609344)).toLocaleString("en-US")} km` : `${Math.max(1, Math.round(mi)).toLocaleString("en-US")} mi`;
/** "35 miles" / "56 km", for sentences. */
export const distanceWords = (mi: number, units: Units = "mi") =>
  units === "km" ? `${Math.round(mi * 1.609344).toLocaleString("en-US")} km` : `${Math.round(mi).toLocaleString("en-US")} ${Math.round(mi) === 1 ? "mile" : "miles"}`;

/* ---------- loading ---------- */

let loading: Promise<Place[]> | null = null;

/** Turns one country's city file into places. */
export const placesFromFile = (country: Country, d: { cities: [string, string, number, number, number][] }): Place[] =>
  d.cities.map(([name, state, lat, lng, pop]) => ({ name, state, country, lat, lng, pop }));

export function loadPlaces(): Promise<Place[]> {
  if (!loading) {
    loading = Promise.all(
      COUNTRIES.map((c) =>
        fetch(`/cities-${c.toLowerCase()}.json`).then((r) => {
          if (!r.ok) throw new Error(`cities ${r.status}`);
          return r.json().then((d) => placesFromFile(c, d));
        }),
      ),
    )
      // Biggest first across every country (search stops at the first matches it finds).
      .then((lists) => lists.flat().sort((a, b) => b.pop - a.pop))
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

const isRegionCode = (code: string) => COUNTRIES.some((c) => REGION_NAMES[c][code]) || isCountry(code);

/** Does "nc", "ontario", "nsw", "canada" or "australia" describe where this place is? */
function matchesRegion(p: Place, part: string): boolean {
  const st = part.trim().toUpperCase();
  const f = fold(part);
  if (!f) return true;
  const [region, country] = part.includes(",") ? part.split(",", 2) : [part, ""];
  if (country.trim()) return matchesRegion(p, region) && matchesRegion(p, country);
  // An exact code ("NS", "WA") means that one: Nova Scotia, not New South Wales. Otherwise, the start of one.
  const codeHit = isRegionCode(st) ? p.state === st : p.state.startsWith(st);
  return codeHit || fold(regionName(p)).startsWith(f) || p.country === st || fold(COUNTRY_NAMES[p.country]).startsWith(f) ||
    (p.country === "AU" && st === "AUS") || (p.country === "CA" && st === "CAN") || (p.country === "US" && (st === "USA" || f === "us"));
}

/** City search for the picker: "rale", "raleigh nc", "portland, me", "toronto on", "perth, australia". Biggest places first. */
export function searchPlaces(places: Place[], query: string, limit = 8): Place[] {
  const raw = query.trim();
  if (!raw) return [];
  let [namePart, statePart] = raw.includes(",") ? [raw.slice(0, raw.indexOf(",")), raw.slice(raw.indexOf(",") + 1)] : [raw, ""];
  const m = !statePart && /^(.*\S)\s+([A-Za-z]{2,3})$/.exec(namePart);
  if (m && isRegionCode(m[2].toUpperCase())) [namePart, statePart] = [m[1], m[2]];
  const q = fold(namePart);
  if (!q) return [];
  const starts: Place[] = [];
  const contains: Place[] = [];
  for (const p of places) {
    if (statePart.trim() && !matchesRegion(p, statePart)) continue;
    const n = fold(p.name);
    if (n.startsWith(q)) starts.push(p);
    else if (q.length > 2 && n.includes(q)) contains.push(p);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

export function findPlace(places: Place[], name: string, state: string, country: Country = "US"): Place | undefined {
  const key = placeKey({ name, state, country });
  return places.find((p) => placeKey(p) === key);
}

/** "Durham, NC" → the place, for profiles saved before locations had coordinates (all in the US). */
export function placeFromLabel(places: Place[], label: string): Place | undefined {
  const [name, state] = label.split(",").map((s) => s.trim());
  return name && state ? findPlace(places, name, state, "US") : undefined;
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
  /** Larger cities elsewhere in the home state or province. */
  anchors: Place[];
}

export function sceneFor(home: Place, places: Place[]): Scene {
  const nearby = places.filter((p) => placeKey(p) !== placeKey(home) && miles(home, p) <= SCENE_RADIUS_MI);
  const inState = places.filter((p) => p.state === home.state && p.country === home.country);
  const anchors = inState
    .filter((p, i) => p.pop >= ANCHOR_MIN_POP || i < ANCHOR_MIN_COUNT)
    .filter((p) => placeKey(p) !== placeKey(home) && miles(home, p) > SCENE_RADIUS_MI);
  return { home, nearby, anchors };
}

/**
 * The scene as Milk Crate shows it: `nearby` and `anchors` become the cities in
 * this scene where artists actually are (most artists first), so places with no
 * published music never appear. Home always stays. Use the full scene (sceneFor)
 * to decide who's in it.
 */
export function sceneWithArtists(scene: Scene, artistPlaces: Place[]): Scene {
  const count = new Map<string, { place: Place; n: number }>();
  for (const p of artistPlaces) {
    if (placeKey(p) === placeKey(scene.home) || !inScene(scene, p)) continue;
    const k = placeKey(p);
    count.set(k, { place: p, n: (count.get(k)?.n ?? 0) + 1 });
  }
  const sorted = [...count.values()].sort((a, b) => b.n - a.n || b.place.pop - a.place.pop).map((c) => c.place);
  return {
    home: scene.home,
    nearby: sorted.filter((p) => miles(scene.home, p) <= SCENE_RADIUS_MI),
    anchors: sorted.filter((p) => miles(scene.home, p) > SCENE_RADIUS_MI),
  };
}

/** Is this point part of the scene? */
export function inScene(scene: Scene, pt: Point & { country?: Country }): boolean {
  if (miles(scene.home, pt) <= SCENE_RADIUS_MI) return true;
  // The towns around the state's (or province's) larger cities only count on the same side of a
  // border: Windsor's scene includes Detroit's suburbs only for someone who lives near Windsor.
  return scene.anchors.some((a) => (!pt.country || pt.country === a.country) && miles(a, pt) <= ANCHOR_RADIUS_MI);
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

/* ---------- states, provinces and territories ---------- */

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

export const PROVINCE_NAMES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia",
  NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
export const AU_STATE_NAMES: Record<string, string> = {
  ACT: "Australian Capital Territory", NSW: "New South Wales", NT: "Northern Territory", QLD: "Queensland",
  SA: "South Australia", TAS: "Tasmania", VIC: "Victoria", WA: "Western Australia",
};
export const REGION_NAMES: Record<Country, Record<string, string>> = { US: STATE_NAMES, CA: PROVINCE_NAMES, AU: AU_STATE_NAMES };

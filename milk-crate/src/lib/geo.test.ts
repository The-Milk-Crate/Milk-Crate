import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { distanceLabel, findPlace, inScene, miles, placeKey, placeLabel, placeLabelFrom, placesFromFile, regionAndCountry, sceneFor, sceneSummary, sceneWithArtists, searchPlaces, type Place } from "./geo";

const read = (c: "US" | "CA" | "AU") => placesFromFile(c, JSON.parse(readFileSync(new URL(`../../public/cities-${c.toLowerCase()}.json`, import.meta.url), "utf8")));
const places: Place[] = [...read("US"), ...read("CA"), ...read("AU")].sort((a, b) => b.pop - a.pop);
const get = (n: string, s: string) => findPlace(places, n, s)!;

describe("places", () => {
  it("finds cities as people type them", () => {
    expect(placeLabel(searchPlaces(places, "rale")[0])).toBe("Raleigh, NC");
    expect(placeLabel(searchPlaces(places, "durham nc")[0])).toBe("Durham, NC");
    expect(placeLabel(searchPlaces(places, "portland, me")[0])).toBe("Portland, ME");
    expect(searchPlaces(places, "portland").map((p) => p.state)).toContain("OR");
    expect(searchPlaces(places, "")).toEqual([]);
  });
  it("measures distance in miles", () => {
    expect(Math.round(miles(get("Raleigh", "NC"), get("Durham", "NC")))).toBeGreaterThan(18);
    expect(Math.round(miles(get("Raleigh", "NC"), get("Durham", "NC")))).toBeLessThan(26);
  });
});

describe("scenes", () => {
  const raleigh = sceneFor(get("Raleigh", "NC"), places);
  it("includes nearby cities and the state's larger cities", () => {
    const near = raleigh.nearby.map((p) => p.name);
    expect(near).toEqual(expect.arrayContaining(["Durham", "Cary", "Chapel Hill"]));
    expect(raleigh.anchors.map((p) => p.name)).toEqual(expect.arrayContaining(["Charlotte", "Greensboro"]));
    expect(raleigh.anchors.map((p) => p.state).every((s) => s === "NC")).toBe(true);
    expect(sceneSummary(raleigh)).toMatch(/nearby, plus Charlotte/);
  });
  it("decides who's in the scene", () => {
    expect(inScene(raleigh, get("Carrboro", "NC"))).toBe(true); // nearby
    expect(inScene(raleigh, get("Matthews", "NC"))).toBe(true); // next to Charlotte
    expect(inScene(raleigh, get("Richmond", "VA"))).toBe(false);
  });
  it("small states still get larger cities", () => {
    const vt = sceneFor(get("Montpelier", "VT"), places);
    expect(vt.anchors.length + vt.nearby.length).toBeGreaterThan(0);
  });
});

describe("sceneWithArtists", () => {
  const home: Place = { name: "Durham", state: "NC", country: "US", lat: 35.994, lng: -78.8986, pop: 283506 };
  const raleigh: Place = { name: "Raleigh", state: "NC", country: "US", lat: 35.7721, lng: -78.6386, pop: 467665 };
  const cary: Place = { name: "Cary", state: "NC", country: "US", lat: 35.7915, lng: -78.7811, pop: 174721 };
  const charlotte: Place = { name: "Charlotte", state: "NC", country: "US", lat: 35.2271, lng: -80.8431, pop: 874579 };
  const matthews: Place = { name: "Matthews", state: "NC", country: "US", lat: 35.1168, lng: -80.7237, pop: 29435 };
  const boston: Place = { name: "Boston", state: "MA", country: "US", lat: 42.3601, lng: -71.0589, pop: 675647 };
  const scene = sceneFor(home, [home, raleigh, cary, charlotte, matthews, boston]);
  it("only lists cities in the scene that have artists, most artists first", () => {
    const live = sceneWithArtists(scene, [raleigh, home, matthews, raleigh, boston]);
    expect(live.home).toBe(home);
    expect(live.nearby.map((p) => p.name)).toEqual(["Raleigh"]); // Cary has no artists
    expect(live.anchors.map((p) => p.name)).toEqual(["Matthews"]); // near Charlotte, so in the scene; Charlotte itself has none
  });
  it("is empty with no artists", () => {
    const live = sceneWithArtists(scene, []);
    expect(live.nearby).toEqual([]);
    expect(live.anchors).toEqual([]);
  });
});

describe("Canada and Australia", () => {
  const ca = (n: string, s: string) => findPlace(places, n, s, "CA")!;
  const au = (n: string, s: string) => findPlace(places, n, s, "AU")!;
  it("has their cities with province and state codes", () => {
    expect(ca("Toronto", "ON").pop).toBeGreaterThan(2_000_000);
    expect(ca("Vancouver", "BC")).toBeTruthy();
    expect(au("Sydney", "NSW")).toBeTruthy();
    expect(au("Perth", "WA")).toBeTruthy();
    expect(regionAndCountry(au("Perth", "WA"))).toBe("Western Australia, Australia");
  });
  it("searches by name, province, state or country", () => {
    expect(placeLabel(searchPlaces(places, "toronto")[0])).toBe("Toronto, ON");
    expect(searchPlaces(places, "melbourne vic")[0].country).toBe("AU");
    expect(searchPlaces(places, "halifax, nova scotia")[0].country).toBe("CA");
    expect(searchPlaces(places, "perth, australia")[0].state).toBe("WA");
    expect(searchPlaces(places, "london on")[0].country).toBe("CA");
    // WA is both Washington and Western Australia.
    const wa = searchPlaces(places, "perth wa", 20).map((p) => p.country);
    expect(wa).toContain("AU");
    expect(searchPlaces(places, "spokane wa")[0].state).toBe("WA");
    expect(searchPlaces(places, "sydney, ns")[0].country).toBe("CA");
  });
  it("keeps same-named towns in different countries apart", () => {
    expect(placeKey(au("Perth", "WA"))).not.toBe(placeKey({ name: "Perth", state: "WA", country: "US" }));
    expect(placeKey(get("Durham", "NC"))).toBe("durham|nc"); // US keys never changed
    expect(placeLabelFrom(au("Perth", "WA"), "US")).toBe("Perth, WA, Australia");
    expect(placeLabelFrom(au("Perth", "WA"), "AU")).toBe("Perth, WA");
  });
  it("builds scenes inside the province or state, and across a border nearby", () => {
    const toronto = sceneFor(ca("Toronto", "ON"), places);
    expect(toronto.nearby.map((p) => p.name)).toContain("Mississauga");
    expect(toronto.anchors.every((p) => p.country === "CA" && p.state === "ON")).toBe(true);
    expect(toronto.anchors.map((p) => p.name)).toContain("Ottawa");
    const windsor = sceneFor(ca("Windsor", "ON"), places);
    expect(windsor.nearby.some((p) => p.name === "Detroit" && p.country === "US")).toBe(true);
    // Detroit is next to Windsor, a larger Ontario city, but isn't part of Toronto's scene.
    expect(inScene(toronto, get("Detroit", "MI"))).toBe(false);
    expect(inScene(toronto, ca("Windsor", "ON"))).toBe(true);
    expect(inScene(windsor, get("Detroit", "MI"))).toBe(true);
    const sydney = sceneFor(au("Sydney", "NSW"), places);
    expect(sydney.anchors.map((p) => p.name)).toContain("Newcastle");
    expect(sydney.anchors.every((p) => p.state === "NSW")).toBe(true);
  });
  it("shows kilometres outside the US", () => {
    expect(distanceLabel(35, "km")).toBe("56 km");
    expect(distanceLabel(35)).toBe("35 mi");
  });
});

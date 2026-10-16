import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { findPlace, inScene, miles, placeLabel, sceneFor, sceneSummary, sceneWithArtists, searchPlaces, type Place } from "./geo";

const data = JSON.parse(readFileSync(new URL("../../public/cities-us.json", import.meta.url), "utf8"));
const places: Place[] = data.cities.map(([name, state, lat, lng, pop]: [string, string, number, number, number]) => ({ name, state, lat, lng, pop }));
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
  const home: Place = { name: "Durham", state: "NC", lat: 35.994, lng: -78.8986, pop: 283506 };
  const raleigh: Place = { name: "Raleigh", state: "NC", lat: 35.7721, lng: -78.6386, pop: 467665 };
  const cary: Place = { name: "Cary", state: "NC", lat: 35.7915, lng: -78.7811, pop: 174721 };
  const charlotte: Place = { name: "Charlotte", state: "NC", lat: 35.2271, lng: -80.8431, pop: 874579 };
  const matthews: Place = { name: "Matthews", state: "NC", lat: 35.1168, lng: -80.7237, pop: 29435 };
  const boston: Place = { name: "Boston", state: "MA", lat: 42.3601, lng: -71.0589, pop: 675647 };
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

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { findPlace, inScene, miles, placeLabel, sceneFor, sceneSummary, searchPlaces, type Place } from "./geo";

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

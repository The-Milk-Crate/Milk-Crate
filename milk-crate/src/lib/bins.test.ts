import { describe, expect, it } from "vitest";
import { buildBins, milesLabel } from "./bins";
import { sceneFor, type Place } from "./geo";
import type { Artist, Release } from "./types";

const P = (name: string, lat: number, lng: number, pop = 100000): Place => ({ name, state: "NC", lat, lng, pop });
const durham = P("Durham", 35.994, -78.8986, 283506);
const chapelHill = P("Chapel Hill", 35.9132, -79.0558);
const raleigh = P("Raleigh", 35.7721, -78.6386, 467665);
const charlotte = P("Charlotte", 35.2271, -80.8431, 874579);
const hillsborough = P("Hillsborough", 36.0754, -79.0997, 9000);
const boston: Place = { name: "Boston", state: "MA", lat: 42.36, lng: -71.06, pop: 675647 };
const places = [durham, chapelHill, raleigh, charlotte, hillsborough, boston];

const artist = (id: string, name: string): Artist => ({ id, name, place: "", status: "approved", genres: [], bio: "", accent: "#888888", since: 2026, page: {} });
const release = (id: string, artistId: string, year: number, addedAt?: string): Release => ({ id, artistId, title: id, year, kind: "EP", trackIds: [], addedAt });

const NOW = Date.parse("2026-10-16T12:00:00Z");
const placed = [
  { artist: artist("a1", "Pamelo"), place: durham },
  { artist: artist("a2", "Night Swim"), place: durham },
  { artist: artist("a3", "Hill Static"), place: chapelHill },
  { artist: artist("a4", "Static Hearts"), place: raleigh },
  { artist: artist("a5", "Queen City Hum"), place: charlotte },
  { artist: artist("a6", "Far Away"), place: boston },
];
const releases = [
  release("r1", "a1", 2026, "2026-09-01T00:00:00Z"),
  release("r2", "a2", 2026, "2026-10-01T00:00:00Z"),
  release("r3", "a4", 2026, "2026-10-14T00:00:00Z"),
  release("r4", "a3", 2025),
  release("r5", "a3", 2026, "2026-08-01T00:00:00Z"),
];

describe("buildBins", () => {
  it("puts the center town first, then the scene's towns nearest first", () => {
    const bins = buildBins(sceneFor(durham, places), placed, releases, NOW);
    expect(bins.map((b) => b.place.name)).toEqual(["Durham", "Chapel Hill", "Raleigh", "Charlotte"]);
    expect(bins[0].isCenter).toBe(true);
    expect(bins.find((b) => b.place.name === "Boston")).toBeUndefined();
  });
  it("holds each town's artists and their releases, newest first", () => {
    const bins = buildBins(sceneFor(durham, places), placed, releases, NOW);
    expect(bins[0].artists.map((a) => a.artist.name)).toEqual(["Night Swim", "Pamelo"]);
    expect(bins[0].releases.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(bins[1].releases.map((r) => r.id)).toEqual(["r5", "r4"]);
  });
  it("marks towns with a release from the last week", () => {
    const bins = buildBins(sceneFor(durham, places), placed, releases, NOW);
    expect(bins.filter((b) => b.isNew).map((b) => b.place.name)).toEqual(["Raleigh"]);
  });
  it("keeps an empty bin for a center town with no bands", () => {
    const bins = buildBins(sceneFor(hillsborough, places), placed, releases, NOW);
    expect(bins[0]).toMatchObject({ isCenter: true, artists: [], releases: [] });
    expect(bins[0].place.name).toBe("Hillsborough");
    expect(bins.length).toBeGreaterThan(1);
  });
  it("labels distances", () => {
    expect(milesLabel(0.2)).toBe("1 mi");
    expect(milesLabel(139.6)).toBe("140 mi");
  });
});

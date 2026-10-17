import { describe, expect, it } from "vitest";
import { radioBatch, spreadArtists } from "./radio";
import type { Release, Track } from "./types";

function rng(seed: number) {
  return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
}
const now = Date.parse("2026-10-17T12:00:00Z");
const rel = (id: string, daysOld: number): Release => ({ id, artistId: "x", title: id, year: 2026, kind: "EP", trackIds: [], addedAt: new Date(now - daysOld * 86_400_000).toISOString() });
const t = (id: string, artistId: string, releaseId: string): Track => ({ id, artistId, releaseId, title: id, duration: 180 });

describe("scene radio", () => {
  const releaseById = { old: rel("old", 400), fresh: rel("fresh", 5) };
  const tracks = [
    ...["a1", "a2", "a3", "a4"].map((id) => t(id, "A", "old")),
    ...["b1", "b2"].map((id) => t(id, "B", "old")),
    ...["c1", "c2"].map((id) => t(id, "C", "fresh")),
  ];
  const base = { tracks, releaseById, streams: {}, favorites: new Set<string>(), history: [] as string[], exclude: new Set<string>(), now };

  it("never plays the same band twice in a row when it can be avoided", () => {
    // 4 from A, 2 from B, 2 from C: A B A C A B A C (or similar), no repeats at all.
    const out = spreadArtists([...tracks]);
    for (let i = 1; i < out.length; i++) expect(out[i].artistId).not.toBe(out[i - 1].artistId);
    // And not starting with the band that just played.
    expect(spreadArtists([...tracks], "A")[0].artistId).not.toBe("A");
  });
  it("skips songs you just heard, and keeps going when a small scene runs out", () => {
    const out = radioBatch({ ...base, exclude: new Set(["a1", "b1"]), random: rng(3) });
    expect(out.map((x) => x.id)).not.toContain("a1");
    expect(out.length).toBe(6);
    const tiny = radioBatch({ ...base, exclude: new Set(tracks.map((x) => x.id)), history: ["a1", "a2"], random: rng(4) });
    expect(tiny.length).toBeGreaterThan(0);
  });
  it("leans toward new releases, favorites and bands you haven't heard", () => {
    const firsts: Record<string, number> = {};
    for (let s = 1; s < 3000; s++) {
      const first = radioBatch({ ...base, history: ["a1", "a2", "b1"], favorites: new Set(["b2"]), random: rng(s) })[0];
      firsts[first.artistId] = (firsts[first.artistId] ?? 0) + 1;
    }
    // C: new release and never heard. B: one favorite. A: old and heard.
    // Per song (C has 2, B 2, A 4): new and unheard comes up first well over twice as often as old and heard.
    const perSong = { A: (firsts.A ?? 0) / 4, B: (firsts.B ?? 0) / 2, C: (firsts.C ?? 0) / 2 };
    expect(perSong.C).toBeGreaterThan(perSong.A * 2);
    expect(perSong.B).toBeGreaterThan(perSong.A);
  });
});

import { describe, expect, it } from "vitest";
import { shuffle, weightedShuffle } from "./shuffle";
import type { Rating } from "./types";

// Small deterministic PRNG so tests are repeatable.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("weightedShuffle", () => {
  const tracks: { id: string; rating: Rating }[] = [
    { id: "five", rating: 5 },
    { id: "one", rating: 1 },
    { id: "unrated", rating: 0 },
    { id: "three", rating: 3 },
  ];

  it("keeps every track exactly once", () => {
    const out = weightedShuffle(tracks, (t) => t.rating, mulberry32(1));
    expect(out.map((t) => t.id).sort()).toEqual(tracks.map((t) => t.id).sort());
  });

  it("puts five-star tracks first far more often than one-star tracks", () => {
    const rand = mulberry32(42);
    const firsts: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) {
      const id = weightedShuffle(tracks, (t) => t.rating, rand)[0].id;
      firsts[id] = (firsts[id] ?? 0) + 1;
    }
    expect(firsts.five).toBeGreaterThan(firsts.three);
    expect(firsts.three).toBeGreaterThan(firsts.one);
    expect(firsts.five / (firsts.one ?? 1)).toBeGreaterThan(8);
  });
});

describe("shuffle", () => {
  it("is a permutation", () => {
    const a = [1, 2, 3, 4, 5, 6];
    expect(shuffle(a, mulberry32(7)).sort()).toEqual(a);
  });
});

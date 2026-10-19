import { describe, expect, it } from "vitest";
import { ENV_RATE, findSplits } from "./vinylSplit";

/** A fake side: lead-in noise, songs (loud) with 2s gaps (surface noise), run-out. */
function side(songs: number[], gap = 2, lead = 3, out = 8) {
  const env: number[] = [];
  const push = (secs: number, level: number) => { for (let i = 0; i < secs * ENV_RATE; i++) env.push(level + ((i * 7) % 5) * 0.001); };
  push(lead, 0.004);
  const starts: number[] = [];
  songs.forEach((len, k) => {
    if (k > 0) push(gap, 0.004);
    starts.push(env.length / ENV_RATE);
    push(len, 0.2);
  });
  push(out, 0.004);
  return { env, starts };
}

describe("findSplits", () => {
  it("finds songs from MusicBrainz lengths", () => {
    const { env, starts } = side([200, 180, 240, 150]);
    const r = findSplits(env, [201, 182, 238, 151]);
    expect(r.start).toBeCloseTo(starts[0], 0);
    expect(r.cuts).toHaveLength(3);
    r.cuts.forEach((c, i) => expect(Math.abs(c - starts[i + 1])).toBeLessThan(2.5));
    expect(r.unsure.every((u) => !u)).toBe(true);
  });

  it("copes with a record playing a little fast", () => {
    const { env, starts } = side([190, 171, 228]);
    const r = findSplits(env, [200, 180, 240]);
    r.cuts.forEach((c, i) => expect(Math.abs(c - starts[i + 1])).toBeLessThan(2.5));
  });

  it("finds the quiet gaps without lengths", () => {
    const { env, starts } = side([120, 90, 200]);
    const r = findSplits(env);
    expect(r.cuts).toHaveLength(2);
    r.cuts.forEach((c, i) => expect(Math.abs(c - starts[i + 1])).toBeLessThan(2.5));
  });

  it("isn't thrown off by one wrong length", () => {
    const { env, starts } = side([231, 293, 341, 200, 343, 163]);
    const r = findSplits(env, [231, 293, 341, 200, 343, 318]);
    r.cuts.forEach((c, i) => expect(Math.abs(c - starts[i + 1])).toBeLessThan(2.5));
  });

  it("flags a cut where there was no gap", () => {
    const env = Array.from({ length: 400 * ENV_RATE }, () => 0.2);
    const r = findSplits(env, [200, 200]);
    expect(r.unsure[0]).toBe(true);
  });
});

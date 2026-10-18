import { describe, expect, it } from "vitest";
import { discoveryOrder, discoverySet, seededShuffle } from "./discovery";

const a = (id: string) => ({ id });
const all = ["a", "b", "c", "d", "e", "f"].map(a);

describe("discovery", () => {
  it("shuffles the same way for the same day, differently on another", () => {
    expect(seededShuffle(all, 5)).toEqual(seededShuffle(all, 5));
    expect(seededShuffle(all, 5).map((x) => x.id).join("")).not.toBe(seededShuffle(all, 6).map((x) => x.id).join(""));
    expect(seededShuffle(all, 5).map((x) => x.id).sort().join("")).toBe("abcdef");
  });
  it("puts sound-alikes first", () => {
    expect(discoveryOrder(all, ["e", "c"], 1).slice(0, 2).map((x) => x.id)).toEqual(["e", "c"]);
  });
  it("rotates through sets, wrapping around", () => {
    expect(discoverySet(all, 0, 4).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(discoverySet(all, 1, 4).map((x) => x.id)).toEqual(["e", "f", "a", "b"]);
    expect(discoverySet(all.slice(0, 3), 7, 4)).toHaveLength(3);
  });
});

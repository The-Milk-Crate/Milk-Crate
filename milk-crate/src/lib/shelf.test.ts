import { describe, expect, it } from "vitest";
import { sortShelf } from "./shelf";

const items = [
  { artist: "Static Hearts", title: "Feedback Season", year: 2025 },
  { artist: "porch light", title: "Slow Kitchen", year: 2026 },
  { artist: "Some Band", title: "Thrift Store Find" },
  { artist: "Porch Light", title: "Kitchen Radio", year: 2026 },
];

describe("sorting your shelf", () => {
  it("A–Z goes by artist, then title, ignoring case", () => {
    expect(sortShelf(items, "az").map((x) => x.title)).toEqual(["Kitchen Radio", "Slow Kitchen", "Thrift Store Find", "Feedback Season"]);
  });
  it("year goes newest first, with no year last", () => {
    expect(sortShelf(items, "year").map((x) => x.title)).toEqual(["Kitchen Radio", "Slow Kitchen", "Feedback Season", "Thrift Store Find"]);
  });
});

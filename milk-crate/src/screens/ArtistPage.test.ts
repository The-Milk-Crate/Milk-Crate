import { describe, expect, it } from "vitest";
import { topRated } from "./ArtistPage";
import type { Track } from "../lib/types";

const t = (id: string): Track => ({ id, releaseId: "r", artistId: "a", title: id, duration: 1 });

describe("popular songs", () => {
  it("ranks by average rating, then by how many people rated, then album order", () => {
    const tracks = ["a", "b", "c", "d", "e", "f"].map(t);
    const avg = { a: 3, b: 4.5, c: 4.5, d: 5, f: 2 };
    const count = { b: 2, c: 9, d: 1, a: 4, f: 1 };
    expect(topRated(tracks, avg, count).map((x) => x.id)).toEqual(["d", "c", "b", "a", "f", "e"]);
  });
});

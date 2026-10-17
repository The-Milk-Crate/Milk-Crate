import { describe, expect, it } from "vitest";
import { mostStreamed } from "./ArtistPage";
import type { Track } from "../lib/types";

const t = (id: string): Track => ({ id, releaseId: "r", artistId: "a", title: id, duration: 1 });

describe("popular songs", () => {
  it("ranks by streams, then album order", () => {
    const tracks = ["a", "b", "c", "d", "e"].map(t);
    expect(mostStreamed(tracks, { a: 3, b: 40, c: 40, d: 1200 }).map((x) => x.id)).toEqual(["d", "b", "c", "a", "e"]);
    expect(mostStreamed(tracks, {}).map((x) => x.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

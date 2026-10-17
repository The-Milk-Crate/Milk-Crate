import { describe, expect, it } from "vitest";
import { buildCrate, byRecentlyPlayed, kindFor } from "./crate";
import type { Release } from "./types";

const rel = (id: string, n: number, kind: Release["kind"] = "LP"): Release => ({ id, artistId: "a", title: id, year: 2026, kind, trackIds: Array.from({ length: n }, (_, i) => `${id}-${i + 1}`) });
const releaseById = { lp: rel("lp", 10), ep: rel("ep", 3, "EP"), single: rel("single", 1, "Single"), other: rel("other", 8) };
const trackRelease = (t: string) => t.split("-")[0];
const iso = (n: number) => new Date(n).toISOString();

describe("your crate", () => {
  it("counts 1–3 songs as singles, doubles, triples and 4+ as albums", () => {
    expect([1, 2, 3, 4, 12].map(kindFor)).toEqual(["single", "double", "triple", "album", "album"]);
  });
  it("groups songs by release", () => {
    const crate = buildCrate(
      [{ releaseId: "lp", addedAt: iso(1000) }, { releaseId: "single", addedAt: iso(900) }],
      [{ trackId: "other-2", addedAt: iso(2000) }, { trackId: "other-5", addedAt: iso(2100) }, { trackId: "ep-1", addedAt: iso(500) },
        { trackId: "ep-2", addedAt: iso(500) }, { trackId: "ep-3", addedAt: iso(500) }],
      releaseById, trackRelease,
    );
    const kind = Object.fromEntries(crate.map((e) => [e.release.id, [e.kind, e.trackIds.length, e.whole]]));
    expect(kind).toEqual({ lp: ["album", 10, true], single: ["single", 1, true], other: ["double", 2, false], ep: ["triple", 3, false] });
    // Songs keep the release's order.
    expect(crate.find((e) => e.release.id === "other")!.trackIds).toEqual(["other-2", "other-5"]);
  });
  it("adding a 4th song from a release moves it to albums", () => {
    const songs = ["other-1", "other-2", "other-3", "other-4"].map((trackId) => ({ trackId, addedAt: iso(1) }));
    expect(buildCrate([], songs.slice(0, 3), releaseById, trackRelease)[0].kind).toBe("triple");
    expect(buildCrate([], songs, releaseById, trackRelease)[0].kind).toBe("album");
  });
  it("puts a whole EP under albums, and a whole single under singles", () => {
    const crate = buildCrate([{ releaseId: "ep", addedAt: iso(1) }, { releaseId: "single", addedAt: iso(1) }], [], releaseById, trackRelease);
    expect(crate.map((e) => e.kind)).toEqual(["album", "single"]);
  });
  it("sorts by when you last played it", () => {
    const crate = buildCrate([{ releaseId: "lp", addedAt: iso(5) }, { releaseId: "ep", addedAt: iso(9) }, { releaseId: "single", addedAt: iso(7) }], [], releaseById, trackRelease,
      [{ trackId: "lp-1", releaseId: "lp", at: 100 }, { trackId: "single-1", releaseId: "single", at: 50 }]);
    expect(crate.sort(byRecentlyPlayed).map((e) => e.release.id)).toEqual(["lp", "single", "ep"]);
  });
});

import { describe, expect, it } from "vitest";
import { albumKey, groupComputer } from "./fileTags";
import type { FileTags, Track } from "./types";

const t = (id: string, title: string, tags?: FileTags): Track => ({ id: `local:${id}`, releaseId: "local", artistId: "local", title, duration: 0, tags });

describe("Your Computer grouping", () => {
  it("puts two or more files from the same album together, in track order", () => {
    const { albums, songs } = groupComputer([
      t("b", "Two", { artist: "Lake", album: "Shore", trackNo: 2 }),
      t("a", "One", { artist: "lake ", album: "Shore", trackNo: 1 }),
      t("c", "Lone", { artist: "Lake", album: "Other" }),
      t("d", "No tags"),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0].title).toBe("Shore");
    expect(albums[0].tracks.map((x) => x.title)).toEqual(["One", "Two"]);
    expect(songs.map((x) => x.title).sort()).toEqual(["Lone", "No tags"]);
  });

  it("orders by disc, then track", () => {
    const { albums } = groupComputer([
      t("1", "D2T1", { album: "X", discNo: 2, trackNo: 1 }),
      t("2", "D1T9", { album: "X", discNo: 1, trackNo: 9 }),
    ]);
    expect(albums[0].tracks.map((x) => x.title)).toEqual(["D1T9", "D2T1"]);
  });

  it("keeps a compilation together by folder and calls it 'Various artists'", () => {
    const mixed = [t("/m/Mix/1.mp3", "A", { artist: "P", album: "Mix" }), t("/m/Mix/2.mp3", "B", { artist: "Q", album: "Mix" })];
    expect(groupComputer(mixed).albums[0].artist).toBe("Various artists");
    expect(albumKey(t("x.mp3", "x", { album: "Mix", albumArtist: "DJ" }))).toBe("dj|mix");
  });

  it("keeps same-named albums by different artists apart", () => {
    const { albums } = groupComputer([
      t("1", "A", { artist: "P", album: "Hits" }), t("2", "B", { artist: "P", album: "Hits" }),
      t("3", "C", { artist: "Q", album: "Hits" }), t("4", "D", { artist: "Q", album: "Hits" }),
    ]);
    expect(albums).toHaveLength(2);
  });
});

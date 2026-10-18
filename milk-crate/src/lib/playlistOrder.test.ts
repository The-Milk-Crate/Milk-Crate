import { describe, expect, it } from "vitest";
import { mergePlaylistOrder } from "./playlistOrder";

describe("mergePlaylistOrder", () => {
  it("keeps this computer's songs where they were put", () => {
    expect(mergePlaylistOrder(["a", "local:/x.flac", "b"], ["a", "b"])).toEqual(["a", "local:/x.flac", "b"]);
  });
  it("drops songs removed elsewhere and adds new ones at the end", () => {
    expect(mergePlaylistOrder(["a", "local:/x.flac", "b"], ["b", "c"])).toEqual(["local:/x.flac", "b", "c"]);
  });
  it("counts repeats", () => {
    expect(mergePlaylistOrder(["a", "a", "local:/x"], ["a"])).toEqual(["a", "local:/x"]);
    expect(mergePlaylistOrder(["a", "local:/x"], ["a", "a"])).toEqual(["a", "local:/x", "a"]);
  });
  it("is just the account's order with nothing local", () => {
    expect(mergePlaylistOrder(undefined, ["a", "b"])).toEqual(["a", "b"]);
  });
});

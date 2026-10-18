import { describe, expect, it } from "vitest";
import { fromPortable, setComputerSongs, songKey, toPortable } from "./songKeys";

describe("songKeys", () => {
  const a = { id: "local:C:\\Music\\Above\\01.flac", title: "Wake Up", tags: { artist: "Mad Season", album: "Above", trackNo: 1, discNo: 1 } };
  const b = { id: "local:/Users/b/Music/Above/01.flac", title: "Wake  up", tags: { artist: "mad season", album: "ABOVE", trackNo: 1 } };
  it("describes the same song the same way on different computers", () => {
    expect(songKey(a)).toBe(songKey(b));
    expect(songKey(a)).toBe("song:mad season|above|1|1|wake up");
  });
  it("finds this computer's copy", () => {
    setComputerSongs([{ ...b, releaseId: "local", artistId: "local", duration: 0 }]);
    expect(fromPortable(songKey(a))).toBe(b.id);
    expect(toPortable(b.id)).toBe(songKey(a));
    expect(fromPortable("song:x|y|1|1|z")).toBe("song:x|y|1|1|z");
    expect(toPortable("abc")).toBe("abc");
  });
});

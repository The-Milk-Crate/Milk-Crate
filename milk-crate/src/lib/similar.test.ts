import { describe, expect, it } from "vitest";
import { similarArtists } from "./similar";
import type { Artist } from "./types";
import type { SoundProfile } from "./sound";

const artist = (id: string, genres: string[] = []): Artist => ({ id, name: id, place: "Durham, NC", genres, bio: "", accent: "#ffffff", since: 2026, page: {}, status: "approved" });
const sound = (tempo: number, energy: number, brightness: number, dynamics: number): SoundProfile => ({ v: 1, tempo, energy, brightness, dynamics });

describe("similar artists", () => {
  const punk = artist("punk"), punk2 = artist("punk2"), folk = artist("folk", ["Folk"]), folk2 = artist("folk2", ["folk", "Americana"]);
  const sounds = new Map([
    ["punk", sound(170, -9, 3200, 5)],
    ["punk2", sound(165, -10, 3000, 6)],
    ["folk", sound(85, -22, 1100, 16)],
  ]);
  it("ranks by measured sound and explains why", () => {
    const s = similarArtists([punk], [punk2, folk], sounds);
    expect(s.map((x) => x.artist.id)).toEqual(["punk2"]);
    expect(s[0].reason).toMatch(/Sounds like punk: fast, loud, bright, steady/);
  });
  it("falls back to shared genres when there's no sound profile", () => {
    const s = similarArtists([folk], [folk2, punk], sounds);
    expect(s.map((x) => x.artist.id)).toEqual(["folk2"]);
    expect(s[0].reason).toBe("Folk, like folk");
  });
  it("never suggests someone you already follow", () => {
    expect(similarArtists([punk, punk2], [punk, punk2], sounds)).toEqual([]);
  });
});

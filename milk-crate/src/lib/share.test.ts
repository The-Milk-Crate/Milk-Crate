import { describe, expect, it } from "vitest";
import { appLinkFor, linkFor, routeFromLink } from "./share";
import { SHARE_PAGE } from "../config";

describe("share links", () => {
  it("round-trips albums, artists and scenes", () => {
    expect(routeFromLink(linkFor({ kind: "album", id: "abc-123" }))).toEqual({ name: "album", releaseId: "abc-123" });
    expect(routeFromLink(linkFor({ kind: "artist", id: "x" }))).toEqual({ name: "artist", artistId: "x" });
    expect(routeFromLink(linkFor({ kind: "scene", name: "Winston-Salem", state: "NC" }))).toEqual({ name: "scenes", explore: { name: "Winston-Salem", state: "NC" } });
    expect(appLinkFor({ kind: "scene", name: "St. John's", state: "NL", country: "CA" })).toBe("milkcrate://scene/CA/NL/St.%20John's");
    expect(linkFor({ kind: "album", id: "abc-123" })).toBe(`${SHARE_PAGE}?album=abc-123`);
    expect(linkFor({ kind: "scene", name: "Winston-Salem", state: "NC" })).toBe(`${SHARE_PAGE}?scene=NC/Winston-Salem`);
    for (const target of [{ kind: "album", id: "abc" }, { kind: "artist", id: "x" }, { kind: "scene", name: "Perth", state: "WA", country: "AU" }] as const)
      expect(routeFromLink(appLinkFor(target))).toEqual(routeFromLink(linkFor(target)));
    expect(routeFromLink(linkFor({ kind: "scene", name: "St. John's", state: "NL", country: "CA" }))).toEqual({ name: "scenes", explore: { name: "St. John's", state: "NL", country: "CA" } });
    expect(routeFromLink(linkFor({ kind: "scene", name: "Perth", state: "WA", country: "AU" }))).toEqual({ name: "scenes", explore: { name: "Perth", state: "WA", country: "AU" } });
  });
  it("tolerates trailing slashes and rejects other links", () => {
    expect(routeFromLink("milkcrate://album/abc/")).toEqual({ name: "album", releaseId: "abc" });
    expect(routeFromLink("https://example.com/album/abc")).toBeNull();
    expect(routeFromLink("milkcrate://playlist/1")).toBeNull();
  });
});

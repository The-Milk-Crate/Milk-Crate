import { describe, expect, it } from "vitest";
import { blockedBecause, routeAccess } from "./routeAccess";

const out = { ready: true, signedIn: false, artist: false, admin: false };
const listener = { ...out, signedIn: true };
const artist = { ...listener, artist: true };
const admin = { ...listener, admin: true };

describe("routeAccess", () => {
  it("lets anyone browse", () => {
    for (const name of ["home", "artist", "album", "scenes", "policies", "account", "upload", "settings", "computer", "shelf", "crate"])
      expect(blockedBecause(routeAccess({ name }), out)).toBeNull();
  });
  it("needs an account for private pages", () => {
    expect(blockedBecause(routeAccess({ name: "inbox" }), out)).toBe("sign-in");
    expect(blockedBecause(routeAccess({ name: "crate", playlistId: "p" }), out)).toBe("sign-in");
    expect(blockedBecause(routeAccess({ name: "inbox" }), listener)).toBeNull();
  });
  it("keeps artist and reviewer pages to them", () => {
    expect(blockedBecause(routeAccess({ name: "stats" }), listener)).toBe("artist");
    expect(blockedBecause(routeAccess({ name: "stats" }), artist)).toBeNull();
    expect(blockedBecause(routeAccess({ name: "review" }), artist)).toBe("admin");
    expect(blockedBecause(routeAccess({ name: "review" }), admin)).toBeNull();
    expect(blockedBecause(routeAccess({ name: "review" }), { ...admin, ready: false })).toBe("loading");
  });
});

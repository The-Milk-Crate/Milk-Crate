import { describe, expect, it } from "vitest";
import { inkOn, profilesPath, sanitizePage } from "./artistPage";
import { SUPABASE_URL } from "../config";

const file = (p: string) => `${SUPABASE_URL}/storage/v1/object/public/profiles/${p}`;

describe("artist page designs from the server", () => {
  it("keeps valid settings", () => {
    const page = { banner: file("u1/banner-1.jpg"), bannerTall: file("u1/banner-tall-1.jpg"), noShade: true, font: "blackletter", nameColor: "#ff5b3a", bold: true, spacing: 0.1, size: "xl", nameMode: "logo", logo: file("u1/logo-2.png") };
    expect(sanitizePage(page)).toEqual(page);
  });
  it("drops images from other sites and anything that could break CSS", () => {
    const page = sanitizePage({
      photo: file("u1/photo-1.jpg"),
      bannerTall: "https://evil.example/x.png",
      banner: file('a.png") ; background: red'),
      logo: "javascript:alert(1)",
      nameColor: "red; position: fixed",
      font: "Comic Sans",
      spacing: 99,
      size: "huge",
      bold: "yes",
    });
    expect(page).toEqual({ spacing: 0.3 });
  });
  it("handles junk", () => {
    expect(sanitizePage(null)).toEqual({});
    expect(sanitizePage("hi")).toEqual({});
  });
  it("finds a file's path for cleanup", () => {
    expect(profilesPath(file("u1/banner-3.webp"))).toBe("u1/banner-3.webp");
    expect(profilesPath("blob:x")).toBe(null);
  });
  it("picks a readable ink for the page color", () => {
    expect(inkOn("#c2b1f8")).toBe("#13110f");
    expect(inkOn("#1d2a6b")).toBe("#f3ede3");
  });
});

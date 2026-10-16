import { describe, expect, it } from "vitest";
import { grainImage, tintScale } from "./settings";

describe("glass transparency", () => {
  it("is unchanged at the default and stays in a readable range", () => {
    expect(tintScale(50)).toBe(1);
    expect(tintScale(0)).toBeCloseTo(1.4);
    expect(tintScale(100)).toBeCloseTo(0.84);
    expect(tintScale(500)).toBeCloseTo(0.84);
  });
});

describe("frosted texture", () => {
  it("is a valid SVG noise image in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const img = grainImage(theme);
      expect(img.startsWith('url("data:image/svg+xml,')).toBe(true);
      const svg = decodeURIComponent(img.slice('url("data:image/svg+xml,'.length, -2));
      expect(svg).toContain("<feTurbulence");
      expect(svg).toContain("url(#");
      expect(svg.match(/</g)!.length).toBe(svg.match(/>/g)!.length);
    }
  });
});

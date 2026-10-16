import { describe, expect, it } from "vitest";
import { paletteFromPixels } from "./palette";

const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const fill = (rgb: [number, number, number], n: number) => Array.from({ length: n }, () => rgb);

describe("album cover palettes", () => {
  it("picks the cover's main colors, most prominent first", () => {
    const px = [...fill([220, 40, 40], 600), ...fill([30, 60, 200], 300), ...fill([240, 200, 40], 100)];
    const p = paletteFromPixels(px);
    expect(p).toHaveLength(4);
    expect(hue(p[0])).toBeLessThan(15); // red
    expect(Math.abs(hue(p[1]) - 228)).toBeLessThan(20); // blue
    expect(Math.abs(hue(p[2]) - 50)).toBeLessThan(15); // yellow
  });
  it("fills out single-color covers with shades", () => {
    const p = paletteFromPixels(fill([20, 160, 90], 500));
    expect(p).toHaveLength(4);
    expect(new Set(p).size).toBe(4);
  });
  it("keeps colors glowy, never black or white", () => {
    const p = paletteFromPixels([...fill([5, 5, 30], 500), ...fill([250, 250, 255], 500)]);
    for (const c of p) {
      const v = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      expect(Math.max(...v)).toBeGreaterThan(60);
      expect(Math.min(...v)).toBeLessThan(230);
    }
  });
});

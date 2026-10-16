import { describe, expect, it } from "vitest";
import { accentForHue, contrast, defaultAccent, dominantHue, rgbToOklch, hexToRgb } from "./accent";
import { sleeveHue } from "./sleeve";

const GROUNDS = { dark: ["#13110f", "#1d1a17"], light: ["#f3eee5", "#fffcf6"] } as const;

describe("accent", () => {
  it("defaults to lavender", () => {
    expect(defaultAccent("dark").accent).toBe("#cfb1f8");
    expect(defaultAccent("light").accent).toBe("#6c4ab3");
  });

  it.each(["dark", "light"] as const)("default lavender is readable in %s theme", (theme) => {
    const a = defaultAccent(theme);
    for (const g of [...GROUNDS[theme], a.soft]) expect(contrast(a.accent, g)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.on, a.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["dark", "light"] as const)("stays readable for every hue in %s theme", (theme) => {
    for (let h = 0; h < 360; h += 5) {
      const a = accentForHue(h, theme);
      for (const g of [...GROUNDS[theme], a.soft]) expect(contrast(a.accent, g)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(a.on, a.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("finds the vivid hue and ignores greys", () => {
    const red = hexToRgb("#ff5b3a");
    const grey = hexToRgb("#777777");
    const hue = dominantHue([red, red, grey, grey, grey, grey]);
    expect(Math.abs((hue ?? 0) - rgbToOklch(red).h)).toBeLessThan(1);
    expect(dominantHue([grey, grey])).toBeNull();
  });

  it("reads a hue from generated sleeves", () => {
    const h = sleeveHue("Basement TapesPink Insulation");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

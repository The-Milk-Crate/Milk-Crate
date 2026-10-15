/**
 * Generated album art ("sleeves") for releases without artist-supplied art.
 * The same seed always produces the same sleeve, and the accent color can
 * read a sleeve's signature hue without rendering it.
 */
import { hexToRgb, rgbToOklch } from "./accent";

export type SleeveColor = "crate" | "dairy" | "sticker" | "ink";

/** Brand fill values (dark theme) used to work out a sleeve's hue. Keep in sync with tokens.css. */
const FILL_HEX: Record<Exclude<SleeveColor, "ink">, string> = {
  crate: "#bf69f7",
  dairy: "#cfb1f8",
  sticker: "#ffd43b",
};

const PALETTES: [SleeveColor, SleeveColor, SleeveColor][] = [
  ["crate", "ink", "sticker"],
  ["dairy", "sticker", "ink"],
  ["sticker", "ink", "crate"],
  ["ink", "crate", "dairy"],
];

function hash(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/** One place that decides a release's seed, so cards, headers and the player agree. */
export const sleeveSeed = (releaseTitle: string, artistName: string) => releaseTitle + artistName;

export function sleeveDesign(seed: string) {
  const n = hash(seed);
  const [a, b, c] = PALETTES[n % PALETTES.length];
  return { n, a, b, c, variant: (n >>> 4) % 4 };
}

/** The hue a generated sleeve "reads as": its background, or its main shape if the background is ink. */
export function sleeveHue(seed: string): number {
  const { a, b } = sleeveDesign(seed);
  const main = a !== "ink" ? a : b;
  return rgbToOklch(hexToRgb(FILL_HEX[main as Exclude<SleeveColor, "ink">])).h;
}

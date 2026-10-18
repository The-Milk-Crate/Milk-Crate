/**
 * Album-reactive accent color.
 *
 * The UI accent (play button, primary buttons, now-playing row, active nav)
 * defaults to lavender. While something plays, the accent takes the album
 * art's most vivid hue and re-casts it at the same lightness and chroma as
 * lavender — so it always matches the record but stays as readable as the
 * default. Contrast is checked against the theme's grounds and nudged if needed.
 *
 * Crate red stays the brand color (logo, stickers); only the accent moves.
 */

export type Theme = "dark" | "light";
export interface AccentSet { accent: string; soft: string; on: string }

/** Default lavender hue in OKLCH degrees. */
export const LAVENDER_HUE = 295;

/** Lightness/chroma targets per theme (OKLCH). Matches the design system tokens. */
const TARGET = {
  dark: { L: 0.8, C: 0.1, softL: 0.27, softC: 0.045, on: "#13110f", grounds: ["#13110f", "#1d1a17"] },
  // #e6ded2: light frosted glass with bright album colors behind it (the darkest a light background gets).
  light: { L: 0.5, C: 0.16, softL: 0.93, softC: 0.035, on: "#ffffff", grounds: ["#f3eee5", "#fffcf6", "#e6ded2"] },
} as const;

/* ---------- color math (sRGB ⇄ OKLCH) ---------- */
type RGB = [number, number, number]; // 0–255

const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

export function rgbToOklch([r, g, b]: RGB): { L: number; C: number; h: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** True if the OKLCH color can be shown on screen as-is (no channel clipped, which would shift its hue). */
export function inGamut(L: number, C: number, h: number): boolean {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].every((x) => x >= -0.001 && x <= 1.001);
}

export function oklchToHex(L: number, C: number, h: number): string {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => Math.round(Math.max(0, Math.min(255, fromLinear(x)))));
  return "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* ---------- accent from a hue ---------- */

/** Builds accent / accent-soft / on-accent for a hue, guaranteeing 4.5:1 text contrast. */
export function accentForHue(hue: number, theme: Theme, chroma?: number): AccentSet {
  const t = TARGET[theme];
  let L: number = t.L;
  let C = chroma ?? t.C;
  const soft = oklchToHex(t.softL, chroma === undefined ? t.softC : Math.min(t.softC, C * 0.45), hue);
  // A picked color can be more vivid than the screen can show at this lightness: ease off so the hue stays true.
  const fit = () => {
    if (chroma !== undefined) while (C > 0 && !inGamut(L, C, hue)) C = Math.max(0, C - 0.005);
  };
  fit();
  let accent = oklchToHex(L, C, hue);
  const ok = (c: string) => [...t.grounds, soft].every((g) => contrast(c, g) >= 4.5) && contrast(t.on, c) >= 4.5;
  // Dark theme: brighten until readable. Light theme: darken.
  for (let i = 0; i < 20 && !ok(accent); i++) {
    L += theme === "dark" ? 0.01 : -0.01;
    fit();
    accent = oklchToHex(L, C, hue);
  }
  return { accent, soft, on: t.on };
}

/** The lavender defaults, exactly as set in the design system tokens. */
const DEFAULTS: Record<Theme, AccentSet> = {
  dark: { accent: "#cfb1f8", soft: "#28223a", on: "#13110f" },
  light: { accent: "#6c4ab3", soft: "#e9e4fe", on: "#ffffff" },
};
export const defaultAccent = (theme: Theme): AccentSet => DEFAULTS[theme];

/**
 * An accent from a color you picked: keeps its hue (and how vivid it is, within
 * reason) but sets the lightness so text on it, and it on the background, stay readable.
 * Greys stay grey. `null` means the lavender default.
 */
export function accentForColor(hex: string | null, theme: Theme): AccentSet {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return defaultAccent(theme);
  const { C, h } = rgbToOklch(hexToRgb(hex));
  const max = TARGET[theme].C * 1.6;
  return accentForHue(h, theme, C < 0.03 ? 0 : Math.max(0.05, Math.min(max, C)));
}

/* ---------- picking the hue from album art ---------- */

/**
 * The album's signature hue: hues are bucketed and weighted by chroma, so a
 * small bright patch beats a big muddy one. Returns null for greyscale art
 * (then the default lavender is used).
 */
export function dominantHue(pixels: RGB[]): number | null {
  const buckets = new Array(24).fill(0);
  const sums = new Array(24).fill(0).map(() => [0, 0]);
  for (const px of pixels) {
    const { L, C, h } = rgbToOklch(px);
    if (C < 0.04 || L < 0.2 || L > 0.97) continue; // skip greys, near-black, near-white
    const i = Math.floor(h / 15) % 24;
    const w = C * C;
    buckets[i] += w;
    sums[i][0] += Math.cos((h * Math.PI) / 180) * w;
    sums[i][1] += Math.sin((h * Math.PI) / 180) * w;
  }
  const best = buckets.indexOf(Math.max(...buckets));
  if (!buckets[best]) return null;
  return ((Math.atan2(sums[best][1], sums[best][0]) * 180) / Math.PI + 360) % 360;
}

/**
 * The album's two signature hues: the strongest, and the strongest one at least 60° away from it
 * that carries a fair share of the color (null if the art is really one color, or greyscale).
 */
export function twoHues(pixels: RGB[]): [number | null, number | null] {
  const buckets = new Array(24).fill(0);
  const sums = new Array(24).fill(0).map(() => [0, 0]);
  for (const px of pixels) {
    const { L, C, h } = rgbToOklch(px);
    if (C < 0.04 || L < 0.2 || L > 0.97) continue;
    const i = Math.floor(h / 15) % 24;
    const w = C * C;
    buckets[i] += w;
    sums[i][0] += Math.cos((h * Math.PI) / 180) * w;
    sums[i][1] += Math.sin((h * Math.PI) / 180) * w;
  }
  const hueOf = (i: number) => ((Math.atan2(sums[i][1], sums[i][0]) * 180) / Math.PI + 360) % 360;
  const first = buckets.indexOf(Math.max(...buckets));
  if (!buckets[first]) return [null, null];
  let second = -1;
  buckets.forEach((w, i) => {
    const apart = Math.min(Math.abs(i - first), 24 - Math.abs(i - first));
    if (apart >= 4 && w >= buckets[first] * 0.06 && (second < 0 || w > buckets[second])) second = i;
  });
  return [hueOf(first), second < 0 ? null : hueOf(second)];
}

/** The pixels of album art (an image URL), small. */
async function artPixels(src: string): Promise<RGB[]> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const px: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
  return px;
}

/** Reads album art and returns its two signature hues (see twoHues). */
export const huesFromImage = async (src: string) => twoHues(await artPixels(src));

/** Reads album art (an image URL) and returns its signature hue. */
export async function hueFromImage(src: string): Promise<number | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const px: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
  return dominantHue(px);
}

/** Writes the accent into CSS variables the whole app reads. */
export function applyAccent(set: AccentSet, el: HTMLElement = document.documentElement) {
  el.style.setProperty("--accent", set.accent);
  el.style.setProperty("--accent-soft", set.soft);
  el.style.setProperty("--on-accent", set.on);
}

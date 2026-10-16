/**
 * The colors of an album cover, for the swirling background behind the glass.
 * Picks up to four distinct, vivid-enough colors (most prominent first) and
 * keeps them in a range that glows nicely behind frosted panels.
 */
import { FILL_HEX, sleeveDesign } from "./sleeve";

type RGB = [number, number, number];

const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Keeps a color glowy: not too dark, not washed out, not blinding. */
function tame([h, s, l]: [number, number, number]): string {
  const ls = Math.min(0.62, Math.max(0.38, l));
  const ss = s < 0.12 ? s : Math.min(0.85, Math.max(0.4, s));
  return toHex(hslToRgb(h, ss, ls));
}

/** Four colors from raw pixels (most prominent first). */
export function paletteFromPixels(px: RGB[], count = 4): string[] {
  const BUCKETS = 18;
  const buckets: { w: number; sum: RGB; n: number }[] = Array.from({ length: BUCKETS + 1 }, () => ({ w: 0, sum: [0, 0, 0], n: 0 }));
  for (const p of px) {
    const [h, s, l] = rgbToHsl(p);
    const vivid = s > 0.18 && l > 0.08 && l < 0.92;
    const i = vivid ? Math.floor(h / (360 / BUCKETS)) % BUCKETS : BUCKETS; // last bucket: greys
    const b = buckets[i];
    b.w += vivid ? 0.4 + s : 0.25;
    b.n++;
    b.sum[0] += p[0]; b.sum[1] += p[1]; b.sum[2] += p[2];
  }
  const ranked = buckets
    .map((b, i) => ({ i, w: b.w, hsl: b.n ? rgbToHsl([b.sum[0] / b.n, b.sum[1] / b.n, b.sum[2] / b.n]) : null }))
    .filter((b) => b.hsl && b.w > 0)
    .sort((a, b) => b.w - a.w);
  const picked: [number, number, number][] = [];
  for (const b of ranked) {
    const hsl = b.hsl!;
    const far = picked.every((p) => Math.min(Math.abs(p[0] - hsl[0]), 360 - Math.abs(p[0] - hsl[0])) >= 28 || (p[1] < 0.12) !== (hsl[1] < 0.12));
    if (far) picked.push(hsl);
    if (picked.length === count) break;
  }
  if (!picked.length) return [];
  // Single-color covers: fill out with lighter and darker shades of the main color.
  const base = picked[0];
  const shifts = [[0, 0.12], [18, -0.1], [-18, 0.05]];
  for (let k = 0; picked.length < count; k++) {
    const [dh, dl] = shifts[k % shifts.length];
    picked.push([(base[0] + dh + 360) % 360, base[1], base[2] + dl]);
  }
  return picked.map(tame);
}

const cache = new Map<string, Promise<string[]>>();

/** Colors of a cover image (any URL the app can display). */
export function paletteFromImage(src: string): Promise<string[]> {
  let p = cache.get(src);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      await img.decode();
      const size = 40;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return [];
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      const px: RGB[] = [];
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
      return paletteFromPixels(px);
    })();
    p.catch(() => cache.delete(src));
    cache.set(src, p);
  }
  return p;
}

/** Colors of a generated sleeve (albums without cover art). */
export function paletteFromSleeve(seed: string): string[] {
  const { a, b, c } = sleeveDesign(seed);
  const hex = [a, b, c].map((k) => FILL_HEX[k as keyof typeof FILL_HEX]).filter(Boolean);
  const px = hex.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as RGB);
  return paletteFromPixels(px.flatMap((p) => Array(10).fill(p)));
}

/**
 * The album colors swirling behind the glass, drawn on one small canvas.
 *
 * It used to be a dozen huge blurred <div>s animated with CSS. Each one was its
 * own GPU layer several thousand pixels across, and in full screen (immersive
 * mode especially) that ran graphics memory out and made the colors flicker.
 * Now the same motion is worked out here and painted at a quarter of the
 * window's size (the colors are soft, so it looks the same scaled up), which
 * costs almost nothing.
 *
 * Two layers, as before: big, soft pools underneath that turn a little faster,
 * offset from the smaller swirl on top so no dark gaps open up. Everything
 * moves only while music plays. The frosted grain (frost.ts) reads the same
 * blobs from `swirlBlobs()` so its refraction matches what's on screen.
 */

type Path = [[number, number, number], [number, number, number], [number, number, number]]; // [dx vmax, dy vmax, scale] at 0%, 50%, 100%
const DRIFT: Record<"a" | "b" | "c" | "d", Path> = {
  a: [[0, 0, 1], [18, 12, 1.18], [-6, 24, 0.92]],
  b: [[0, 0, 1.05], [-22, 16, 0.9], [-10, -12, 1.15]],
  c: [[0, 0, 0.95], [14, -20, 1.12], [24, 6, 1]],
  d: [[0, 0, 1.08], [-16, -14, 0.9], [12, 18, 1.1]],
};

interface BlobSpec { fx: number; fy: number; size: number; drift: keyof typeof DRIFT; period: number; delay: number; color: number }
interface Layer { box: number; turn: number; turnDelay: number; alpha: number; immersiveAlpha: number; blobs: BlobSpec[] }

/** Positions are the blob's center as a fraction of its layer's box; sizes in vmax; times in seconds. */
const LAYERS: Layer[] = [
  {
    box: 210, turn: 76, turnDelay: 25, alpha: 0.85, immersiveAlpha: 0.9,
    blobs: [
      { fx: 0.806, fy: 0.306, size: 120, drift: "c", period: 27, delay: 0, color: 3 },
      { fx: 0.246, fy: 0.346, size: 120, drift: "a", period: 33, delay: 11, color: 4 },
      { fx: 0.586, fy: 0.786, size: 120, drift: "b", period: 30, delay: 6, color: 5 },
      { fx: 0.226, fy: 0.766, size: 120, drift: "d", period: 35, delay: 18, color: 0 },
      { fx: 0.488, fy: 0.168, size: 104, drift: "b", period: 29, delay: 21, color: 1 },
      { fx: 0.822, fy: 0.722, size: 110, drift: "a", period: 31, delay: 3, color: 2 },
    ],
  },
  {
    box: 170, turn: 100, turnDelay: 0, alpha: 0.95, immersiveAlpha: 1,
    blobs: [
      { fx: 0.295, fy: 0.275, size: 80, drift: "a", period: 33, delay: 0, color: 0 },
      { fx: 0.725, fy: 0.335, size: 80, drift: "b", period: 41, delay: 0, color: 1 },
      { fx: 0.375, fy: 0.725, size: 80, drift: "c", period: 37, delay: 0, color: 2 },
      { fx: 0.68, fy: 0.72, size: 68, drift: "a", period: 45, delay: 14, color: 3 },
      { fx: 0.562, fy: 0.482, size: 62, drift: "d", period: 39, delay: 8, color: 4 },
      { fx: 0.214, fy: 0.634, size: 66, drift: "b", period: 47, delay: 22, color: 5 },
    ],
  },
];

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2); // close to CSS ease-in-out
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** A blob on screen: center and radius in CSS px, opacity, and which album color (0–5). */
export interface SwirlBlob { x: number; y: number; r: number; alpha: number; color: number }

/** Where every blob is at time `t` (seconds of music played), for a window of w×h CSS px. Back layer first. */
export function blobsAt(t: number, w: number, h: number, immersive = false): SwirlBlob[] {
  const vmax = Math.max(w, h) / 100;
  const out: SwirlBlob[] = [];
  for (const layer of LAYERS) {
    const L = layer.box * vmax;
    const angle = (2 * Math.PI * (t + layer.turnDelay)) / layer.turn;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    for (const b of layer.blobs) {
      const u = (t + b.delay) / b.period;
      const cycle = Math.floor(u);
      let f = u - cycle;
      if (cycle % 2) f = 1 - f; // alternate
      const [p0, p1, p2] = DRIFT[b.drift];
      const [s, e, k] = f < 0.5 ? [p0, p1, ease(f * 2)] : [p1, p2, ease((f - 0.5) * 2)];
      const dx = mix(s[0], e[0], k) * vmax, dy = mix(s[1], e[1], k) * vmax, scale = mix(s[2], e[2], k);
      // Position within the layer, relative to its center, then turned with the layer.
      const lx = (b.fx - 0.5) * L + dx, ly = (b.fy - 0.5) * L + dy;
      out.push({
        x: w / 2 + lx * cos - ly * sin,
        y: h / 2 + lx * sin + ly * cos,
        r: (b.size * vmax * scale) / 2,
        alpha: immersive ? layer.immersiveAlpha : layer.alpha,
        color: b.color,
      });
    }
  }
  return out;
}

/* ---------- the shared clock and colors ---------- */

type RGB = [number, number, number];
let clock = 0; // seconds of music played since the app opened
let lastTick = 0;
let moving = false;
const shown: RGB[] = [];
let target: RGB[] = [];

const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as RGB;
};

/** The album colors to swirl (they fade over a couple of seconds). */
export function setSwirlColors(colors: string[]) {
  target = colors.map(hexToRgb);
  if (!shown.length) target.forEach((c) => shown.push([...c] as RGB));
}
export function setSwirlMoving(on: boolean) {
  moving = on;
}

/** Advances the clock and color fades; call once per frame. */
function advance(now: number) {
  const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
  lastTick = now;
  if (moving) clock += dt;
  const k = 1 - Math.exp(-dt / 0.8); // ~2.4 s to settle
  let settled = true;
  target.forEach((c, i) => {
    const s = (shown[i] ??= [...c] as RGB);
    for (let j = 0; j < 3; j++) {
      s[j] += (c[j] - s[j]) * k;
      if (Math.abs(c[j] - s[j]) > 0.002) settled = false;
    }
  });
  return settled;
}

/** The blobs on screen right now with their colors, for the frosted grain. */
export function swirlBlobs(immersive: boolean): { blobs: [number, number, number, number][]; colors: RGB[] } {
  const list = blobsAt(clock, window.innerWidth, window.innerHeight, immersive);
  return {
    blobs: list.map((b) => [b.x, b.y, b.r, b.alpha]),
    colors: list.map((b) => shown[b.color] ?? [0.5, 0.5, 0.5]),
  };
}

/* ---------- drawing ---------- */

const canvases = new Map<HTMLCanvasElement, { immersive: boolean; lastKey: string }>();
let raf = 0;
let lastFrame = 0;
const FRAME_MS = 33; // ~30 fps: the motion is slow and smooth
const SCALE = 0.25; // canvas pixels per CSS pixel

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  if (now - lastFrame < FRAME_MS || document.hidden) return;
  lastFrame = now;
  const settled = advance(now);
  const w = window.innerWidth, h = window.innerHeight;
  const cw = Math.max(32, Math.ceil(w * SCALE)), ch = Math.max(32, Math.ceil(h * SCALE));
  const immersiveOpen = document.documentElement.dataset.immersive === "true";
  for (const [canvas, info] of canvases) {
    // While immersive mode covers the window, the main swirl behind it has nothing to show.
    if (!info.immersive && immersiveOpen) continue;
    const key = `${cw}x${ch}:${clock.toFixed(3)}:${settled ? shown.map((c) => c.join()).join("|") : now}`;
    if (key === info.lastKey) continue; // nothing moved
    info.lastKey = key;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const g = canvas.getContext("2d");
    if (!g) continue;
    g.clearRect(0, 0, cw, ch);
    for (const b of blobsAt(clock, w, h, info.immersive)) {
      const c = shown[b.color];
      if (!c) continue;
      const [r, gr, bl] = c.map((v) => Math.round(v * 255));
      const x = b.x * SCALE, y = b.y * SCALE, rad = Math.max(1, b.r * SCALE);
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${r},${gr},${bl},1)`);
      grad.addColorStop(1, `rgba(${r},${gr},${bl},0)`);
      g.globalAlpha = b.alpha;
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.globalAlpha = 1;
  }
}

/** Paints the swirl into `canvas` until the returned function is called. */
export function attachSwirl(canvas: HTMLCanvasElement, immersive: boolean): () => void {
  canvases.set(canvas, { immersive, lastKey: "" });
  if (!raf) raf = requestAnimationFrame(frame);
  return () => {
    canvases.delete(canvas);
    if (!canvases.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      lastTick = 0;
    }
  };
}

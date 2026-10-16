/**
 * Frosted grain that refracts the album colors (experimental, Settings →
 * Appearance → Frosted texture).
 *
 * Real frosted glass is covered in tiny bumps. Each bump is a little lens: it
 * bends light from a spot slightly to one side, so up close every grain glints
 * with the color behind the glass a few pixels away, a touch brighter or darker
 * than the glass around it, with red and blue split a hair apart.
 *
 * Each glass surface (sidebar, main area, player, immersive card) holds a
 * <canvas> that sits on the glass: above its tint, under its text. A small
 * WebGL shader draws one grain per device pixel (sharp, never blurred). To know
 * what's behind the glass it rebuilds the album-color swirl (src/components/
 * Backdrop.tsx) from the live page: where each color blob is right now, how big,
 * what color (mid-transition included), the veil over it and how faded in the
 * whole thing is. Grains are fixed to the window, like etching on a pane.
 *
 * The swirl moves slowly, so the grain redraws ~12 times a second and only when
 * something changed (nothing while paused).
 */

const VERT = `attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uOrigin;   // canvas top-left in the window, CSS px
uniform float uDpr;     // device px per CSS px
uniform float uHeight;  // canvas height, device px
uniform vec4 uBlob[4];  // center x, y (CSS px), radius (CSS px), opacity
uniform vec3 uColor[4];
uniform vec3 uGround;   // the window background under the swirl
uniform vec4 uVeil;     // the veil laid over the swirl (rgb, alpha)
uniform float uOn;      // how faded in the swirl is (0 when nothing plays)
uniform float uSat;     // the surface's saturate(), so grains match the glass they sit on
uniform vec2 uStrength; // max opacity of (light, dark) grains

// Hash without sine (Dave Hoskins): stable white noise per pixel on every GPU.
vec4 hash42(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(.1031, .1030, .0973, .1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// What's behind the glass at q: the blobs over transparent, the veil over them,
// faded in by uOn over the ground (the same compositing the page does).
vec3 behind(vec2 q) {
  vec3 L = vec3(0.0);
  float A = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = clamp(1.0 - length(q - uBlob[i].xy) / uBlob[i].z, 0.0, 1.0) * uBlob[i].w;
    L = uColor[i] * a + L * (1.0 - a);
    A = a + A * (1.0 - a);
  }
  L = uVeil.rgb * uVeil.a + L * (1.0 - uVeil.a);
  A = uVeil.a + A * (1.0 - uVeil.a);
  return uGround * (1.0 - A * uOn) + L * uOn;
}

void main() {
  vec2 local = vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) - 0.5; // device px from the canvas top-left
  vec2 cell = floor(uOrigin * uDpr + 0.5) + local;                   // device px in the window
  vec4 h = hash42(cell);

  // Grain strength: most bumps are barely there, a few catch the light.
  float g = h.x * 2.0 - 1.0;
  float m = pow(abs(g), 3.4);

  // Each bump bends light from a few pixels to one side, in its own direction.
  float ang = h.y * 6.2831853;
  vec2 dir = vec2(cos(ang), sin(ang));
  float reach = 4.0 + 22.0 * h.z;
  vec2 p = (cell + 0.5) / uDpr;
  vec2 d = dir * reach;
  // Dispersion: red bends least, blue most.
  vec3 c = vec3(behind(p + d * 0.9).r, behind(p + d).g, behind(p + d * 1.1).b);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(mix(vec3(lum), c, uSat * 1.15), 0.0, 1.0);

  // Bumps facing the light focus it (a brighter glint of that color);
  // the others throw a small, darker, tinted shadow.
  bool lit = g > 0.0;
  vec3 col = lit ? min(c * 1.45 + 0.04, 1.0) : c * 0.5;
  // Glints need light behind them: they sparkle where the album colors are
  // bright and nearly vanish over dark glass (or when nothing is playing).
  float glow = smoothstep(0.03, 0.45, dot(behind(p), vec3(0.2126, 0.7152, 0.0722)));
  float a = m * (lit ? uStrength.x * mix(0.3, 1.0, glow) : uStrength.y);
  gl_FragColor = vec4(col * a, a);
}`;

type RGB = [number, number, number];
export interface FrostScene {
  blobs: [number, number, number, number][]; // x, y, r, opacity
  colors: RGB[];
  ground: RGB;
  veil: [number, number, number, number];
  on: number;
  light: boolean;
}

const parseColor = (s: string): [number, number, number, number] | null => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [v[0] / 255, v[1] / 255, v[2] / 255, v.length > 3 ? v[3] : 1];
};

/** Reads the swirl as it is on screen right now. null if there's no swirl to read. */
export function readScene(source: "main" | "immersive"): FrostScene | null {
  const el = document.querySelector<HTMLElement>(source === "immersive" ? ".backdrop.backdrop-immersive" : ".backdrop:not(.backdrop-immersive)");
  const root = getComputedStyle(document.documentElement);
  const light = document.documentElement.dataset.theme === "light";
  const groundVar = parseColor(root.getPropertyValue("--ground").trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)})`));
  const ground: RGB = groundVar ? [groundVar[0], groundVar[1], groundVar[2]] : light ? [0.95, 0.93, 0.9] : [0.075, 0.067, 0.06];
  if (!el) return { blobs: [], colors: [], ground, veil: [0, 0, 0, 0], on: 0, light };
  const cs = getComputedStyle(el);
  const on = parseFloat(cs.opacity) || 0;
  const veil = parseColor(getComputedStyle(el, "::after").backgroundColor) ?? [0, 0, 0, 0];
  const blobs: FrostScene["blobs"] = [];
  const colors: RGB[] = [];
  el.querySelectorAll<HTMLElement>(".blob").forEach((b, i) => {
    const r = b.getBoundingClientRect();
    const bs = getComputedStyle(b);
    const t = bs.transform.match(/matrix\(([^)]+)\)/);
    const [ma, mb] = t ? t[1].split(",").map(Number) : [1, 0];
    const scale = Math.hypot(ma, mb) || 1;
    blobs.push([r.left + r.width / 2, r.top + r.height / 2, (b.offsetWidth / 2) * scale, parseFloat(bs.opacity) || 0]);
    const c = parseColor(cs.getPropertyValue(`--swirl-${i + 1}`).trim()) ?? [0.5, 0.5, 0.5, 1];
    colors.push([c[0], c[1], c[2]]);
  });
  return { blobs, colors, ground, veil, on, light };
}

/* ---------- one canvas ---------- */

interface Surface {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  u: Record<string, WebGLUniformLocation | null>;
  source: "main" | "immersive";
  saturate: number;
  lastKey: string;
}

function compile(gl: WebGLRenderingContext): WebGLProgram | null {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("Frosted texture shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}

function setup(canvas: HTMLCanvasElement, source: Surface["source"], saturate: number): Surface | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return null;
  const prog = compile(gl);
  if (!prog) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covering the canvas
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u: Surface["u"] = {};
  for (const n of ["uOrigin", "uDpr", "uHeight", "uBlob", "uColor", "uGround", "uVeil", "uOn", "uSat", "uStrength"]) u[n] = gl.getUniformLocation(prog, n);
  return { canvas, gl, u, source, saturate, lastKey: "" };
}

/** How strong the grains are (max opacity of light / dark grains). Kept subtle. */
const STRENGTH = { dark: [0.26, 0.08], light: [0.1, 0.115] } as const;

function draw(s: Surface, scene: FrostScene) {
  const { canvas, gl, u } = s;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  const key = JSON.stringify([scene, rect.left, rect.top, w, h, dpr]);
  if (key === s.lastKey) return; // nothing changed: keep the last frame
  s.lastKey = key;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const blobs = new Float32Array(16);
  const colors = new Float32Array(12);
  scene.blobs.slice(0, 4).forEach((b, i) => blobs.set([b[0], b[1], Math.max(1, b[2]), b[3]], i * 4));
  scene.colors.slice(0, 4).forEach((c, i) => colors.set(c, i * 3));
  gl.uniform2f(u.uOrigin, rect.left, rect.top);
  gl.uniform1f(u.uDpr, dpr);
  gl.uniform1f(u.uHeight, h);
  gl.uniform4fv(u.uBlob, blobs);
  gl.uniform3fv(u.uColor, colors);
  gl.uniform3fv(u.uGround, scene.ground);
  gl.uniform4fv(u.uVeil, scene.veil);
  gl.uniform1f(u.uOn, scene.blobs.length ? scene.on : 0);
  gl.uniform1f(u.uSat, s.saturate);
  const [sl, sd] = STRENGTH[scene.light ? "light" : "dark"];
  gl.uniform2f(u.uStrength, sl, sd);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ---------- shared loop ---------- */

const surfaces = new Set<Surface>();
const FRAME_MS = 80; // ~12 fps is plenty: the swirl takes minutes to turn
let raf = 0;
let last = 0;

function tick(now: number) {
  raf = requestAnimationFrame(tick);
  if (now - last < FRAME_MS || document.hidden) return;
  last = now;
  const scenes: Partial<Record<Surface["source"], FrostScene | null>> = {};
  for (const s of surfaces) {
    const scene = (scenes[s.source] ??= readScene(s.source));
    if (scene) draw(s, scene);
  }
}

/** Starts drawing the frosted grain into `canvas`. Returns a function that stops it. Does nothing without WebGL. */
const built = new WeakMap<HTMLCanvasElement, Surface>();

export function attachFrost(canvas: HTMLCanvasElement, opts: { source?: Surface["source"]; saturate?: number } = {}): () => void {
  let s = built.get(canvas) ?? null;
  if (!s || s.gl.isContextLost()) {
    s = setup(canvas, opts.source ?? "main", opts.saturate ?? 1);
    if (s) built.set(canvas, s);
  } else {
    s.source = opts.source ?? "main";
    s.saturate = opts.saturate ?? 1;
    s.lastKey = "";
  }
  if (!s) {
    canvas.style.display = "none";
    return () => {};
  }
  const surface = s;
  const lost = (e: Event) => {
    e.preventDefault();
    surfaces.delete(surface);
  };
  canvas.addEventListener("webglcontextlost", lost);
  surfaces.add(s);
  last = 0; // draw on the next frame
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    canvas.removeEventListener("webglcontextlost", lost);
    surfaces.delete(s);
    // Free the GPU context once the canvas is really gone (not when React re-runs the effect on the same canvas).
    setTimeout(() => !canvas.isConnected && s.gl.getExtension("WEBGL_lose_context")?.loseContext(), 0);
    if (!surfaces.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

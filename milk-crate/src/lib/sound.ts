/**
 * Sound profiles: a few measurements of how a track sounds, taken in the app
 * when an artist uploads it. Used for "similar sound" recommendations.
 *
 *   tempo       beats per minute (from how often the loudness jumps)
 *   energy      overall loudness, dBFS (−60 quiet … 0 very loud)
 *   brightness  spectral centroid in Hz (higher = brighter, more treble)
 *   dynamics    loudness range in dB (quiet-to-loud spread; low = compressed/steady)
 */
export interface SoundProfile { v: 1; tempo: number; energy: number; brightness: number; dynamics: number }

const FRAME = 1024;
const HOP = 512;
const FFT_SIZE = 2048;

/** Measures mono samples. Uses up to 90 seconds from the middle of the track. */
export function analyzeSamples(input: Float32Array, sampleRate: number): SoundProfile {
  const maxLen = Math.floor(sampleRate * 90);
  const start = input.length > maxLen ? Math.floor((input.length - maxLen) / 2) : 0;
  const x = input.subarray(start, start + Math.min(maxLen, input.length));

  // Loudness per frame.
  const frames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const rms = new Float32Array(frames);
  let total = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const o = f * HOP;
    for (let i = 0; i < FRAME; i++) sum += x[o + i] * x[o + i];
    rms[f] = Math.sqrt(sum / FRAME);
  }
  for (let i = 0; i < x.length; i++) total += x[i] * x[i];
  const overall = Math.sqrt(total / Math.max(1, x.length));
  const energy = round(20 * Math.log10(Math.max(overall, 1e-6)), 1);

  const db = Array.from(rms).filter((r) => r > 1e-4).map((r) => 20 * Math.log10(r)).sort((a, b) => a - b);
  const dynamics = db.length ? round(pct(db, 0.95) - pct(db, 0.1), 1) : 0;

  return { v: 1, tempo: round(tempoOf(rms, sampleRate), 1), energy, brightness: round(brightnessOf(x, sampleRate), 0), dynamics };
}

function tempoOf(rms: Float32Array, sampleRate: number): number {
  if (rms.length < 64) return 0;
  // Onset strength: how much louder each frame is than the one before.
  const logE = Array.from(rms, (r) => Math.log(r + 1e-6));
  const onset = new Float32Array(logE.length);
  for (let i = 1; i < logE.length; i++) onset[i] = Math.max(0, logE[i] - logE[i - 1]);
  const mean = onset.reduce((a, b) => a + b, 0) / onset.length;
  for (let i = 0; i < onset.length; i++) onset[i] -= mean;
  // Autocorrelation over lags between 200 and 50 BPM.
  const fps = sampleRate / HOP;
  const minLag = Math.max(1, Math.floor((60 * fps) / 200));
  const maxLag = Math.min(onset.length - 1, Math.ceil((60 * fps) / 50));
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1 && lag < onset.length; lag++) {
    let s = 0;
    for (let i = lag; i < onset.length; i++) s += onset[i] * onset[i - lag];
    ac[lag] = s / (onset.length - lag);
  }
  // Prefer musically common tempos (gently favor 80–160 BPM), then refine the peak.
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = ac[lag] * weight;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (!best || ac[best] <= 0) return 0;
  const a = ac[best - 1] ?? 0, b = ac[best], c = ac[best + 1] ?? 0;
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return (60 * fps) / (best + Math.max(-0.5, Math.min(0.5, shift)));
}

function brightnessOf(x: Float32Array, sampleRate: number): number {
  const n = FFT_SIZE;
  const count = Math.floor(x.length / n);
  if (!count) return 0;
  const step = Math.max(1, Math.floor(count / 200));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let weighted = 0;
  let weights = 0;
  for (let k = 0; k < count; k += step) {
    const o = k * n;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re[i] = x[o + i] * w;
      im[i] = 0;
      e += x[o + i] * x[o + i];
    }
    if (e < 1e-6) continue;
    fft(re, im);
    let num = 0;
    let den = 0;
    for (let i = 1; i < n / 2; i++) {
      const mag = Math.hypot(re[i], im[i]);
      num += ((i * sampleRate) / n) * mag;
      den += mag;
    }
    if (den > 0) {
      weighted += (num / den) * e;
      weights += e;
    }
  }
  return weights ? weighted / weights : 0;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/* ---------- comparing sounds ---------- */

/** Puts each measurement on a roughly 0–1 scale so they count equally. */
export function soundVector(s: SoundProfile): number[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(((s.tempo || 110) - 60) / 120),
    clamp((s.energy + 40) / 40),
    clamp(Math.log2(Math.max(s.brightness, 100) / 200) / 5),
    clamp(s.dynamics / 24),
  ];
}

export function averageSound(profiles: SoundProfile[]): SoundProfile | null {
  if (!profiles.length) return null;
  const avg = (k: "tempo" | "energy" | "brightness" | "dynamics") => profiles.reduce((s, p) => s + p[k], 0) / profiles.length;
  return { v: 1, tempo: avg("tempo"), energy: avg("energy"), brightness: avg("brightness"), dynamics: avg("dynamics") };
}

/** 0 = identical sound, ~2 = very different. */
export function soundDistance(a: SoundProfile, b: SoundProfile): number {
  const va = soundVector(a), vb = soundVector(b);
  return Math.sqrt(va.reduce((s, v, i) => s + (v - vb[i]) ** 2, 0));
}

/** Plain-words description of what two sounds share, for "why we picked this". */
export function sharedQualities(a: SoundProfile, b: SoundProfile): string {
  const words = (s: SoundProfile) => [
    s.tempo >= 135 ? "fast" : s.tempo && s.tempo <= 95 ? "slow" : "mid-tempo",
    s.energy >= -14 ? "loud" : s.energy <= -24 ? "quiet" : "",
    s.brightness >= 2600 ? "bright" : s.brightness <= 1200 ? "warm" : "",
    s.dynamics >= 14 ? "dynamic" : s.dynamics <= 6 ? "steady" : "",
  ].filter(Boolean);
  const wb = new Set(words(b));
  const both = words(a).filter((w) => wb.has(w));
  return both.length ? both.join(", ") : "a similar overall sound";
}

export function isSoundProfile(v: unknown): v is SoundProfile {
  const s = v as SoundProfile;
  return !!s && typeof s === "object" && [s.tempo, s.energy, s.brightness, s.dynamics].every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Loudness for the Normalizer: integrated loudness (LUFS, ITU-R BS.1770-4 with
 * gating, the same measure streaming services use) and true peak (dBTP, 4x
 * oversampled), from samples decoded at 48 kHz.
 *
 * The Normalizer then turns each song up or down so it plays at TARGET_LUFS,
 * but never so far that its peaks would go over CEILING_DBTP. A quiet song with
 * big peaks stops short of the target rather than being squashed by a limiter,
 * so nothing about the artist's master changes except its volume.
 */

export const TARGET_LUFS = -13;
export const CEILING_DBTP = -1;
/** Never boost or cut more than this, whatever the measurement says. */
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = 24;

export const MEASURE_RATE = 48000;

export interface Loudness {
  /** Integrated loudness, LUFS. -Infinity for silence. */
  lufs: number;
  /** True peak, dBTP. */
  peak: number;
}

/** How much to change a song's volume, in dB (positive is louder). */
export function normalizerGainDb(l: Loudness): number {
  if (!Number.isFinite(l.lufs)) return 0;
  const toTarget = TARGET_LUFS - l.lufs;
  const headroom = Number.isFinite(l.peak) ? CEILING_DBTP - l.peak : MAX_BOOST_DB;
  return Math.max(-MAX_CUT_DB, Math.min(toTarget, headroom, MAX_BOOST_DB));
}

/* ---------- integrated loudness ---------- */

// K-weighting at 48 kHz (BS.1770-4, table 1 and 2): a high shelf, then a high-pass.
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const HIGHPASS = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };

/** Mean square of the K-weighted signal in each 100 ms step. */
function stepPower(x: Float32Array, step: number): Float64Array {
  const steps = Math.floor(x.length / step);
  const out = new Float64Array(steps);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // shelf state
  let u1 = 0, u2 = 0, z1 = 0, z2 = 0; // high-pass state
  for (let s = 0; s < steps; s++) {
    let sum = 0;
    for (let i = s * step, end = i + step; i < end; i++) {
      const x0 = x[i];
      const y0 = SHELF.b[0] * x0 + SHELF.b[1] * x1 + SHELF.b[2] * x2 - SHELF.a[0] * y1 - SHELF.a[1] * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      const z0 = HIGHPASS.b[0] * y0 + HIGHPASS.b[1] * u1 + HIGHPASS.b[2] * u2 - HIGHPASS.a[0] * z1 - HIGHPASS.a[1] * z2;
      u2 = u1; u1 = y0; z2 = z1; z1 = z0;
      sum += z0 * z0;
    }
    out[s] = sum / step;
  }
  return out;
}

const blockLoudness = (z: number) => -0.691 + 10 * Math.log10(z);

/**
 * Integrated loudness of left/right channels at 48 kHz. Mono plays from both
 * speakers, so it's measured as the same signal in both.
 */
export function integratedLoudness(channels: Float32Array[]): number {
  const step = MEASURE_RATE / 10; // 100 ms; a block is 4 steps (400 ms, 75% overlap)
  const chans = channels.length === 1 ? [channels[0], channels[0]] : channels.slice(0, 2);
  const powers = chans.map((c) => stepPower(c, step));
  const steps = Math.min(...powers.map((p) => p.length));
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= steps; s++) {
    let z = 0;
    for (const p of powers) z += (p[s] + p[s + 1] + p[s + 2] + p[s + 3]) / 4;
    blocks.push(z);
  }
  // Absolute gate at -70 LUFS, then a relative gate 10 LU under what's left.
  const loud = blocks.filter((z) => blockLoudness(z) > -70);
  if (!loud.length) return -Infinity;
  const relative = blockLoudness(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((z) => blockLoudness(z) > relative);
  return blockLoudness(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/* ---------- true peak ---------- */

const TAPS = 12; // per phase; 4 phases = a 48-tap interpolation filter
const HALF = TAPS / 2;
/** Interpolation weights for the points 1/4, 2/4 and 3/4 of the way to the next sample. */
const PHASES = [1, 2, 3].map((k) => {
  const w = Array.from({ length: TAPS }, (_, j) => {
    const t = k / 4 - (j - HALF + 1); // distance from sample n + (j - HALF + 1)
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const win = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF) + 0.08 * Math.cos((2 * Math.PI * t) / HALF); // Blackman
    return Math.abs(t) < HALF ? sinc * win : 0;
  });
  const sum = w.reduce((a, b) => a + b, 0);
  return Float64Array.from(w, (v) => v / sum);
});

/** True peak in dBTP: the highest level between samples, found by 4x oversampling. */
export function truePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const x of channels) {
    let samplePeak = 0;
    for (let i = 0; i < x.length; i++) samplePeak = Math.max(samplePeak, Math.abs(x[i]));
    peak = Math.max(peak, samplePeak);
    // Only look between samples near the loudest ones (that's where overs happen).
    const near = samplePeak * 0.5;
    for (let n = HALF - 1; n + HALF < x.length; n++) {
      if (Math.abs(x[n]) < near && Math.abs(x[n + 1]) < near) continue;
      for (const h of PHASES) {
        let y = 0;
        for (let j = 0; j < TAPS; j++) y += h[j] * x[n - HALF + 1 + j];
        if (Math.abs(y) > peak) peak = Math.abs(y);
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function measureLoudness(channels: Float32Array[]): Loudness {
  return { lufs: integratedLoudness(channels), peak: truePeak(channels) };
}

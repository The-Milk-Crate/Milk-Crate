/**
 * Finding the songs in a recorded side of a record: where the music starts and ends, and the
 * quiet gaps between songs. With MusicBrainz's song lengths it looks for the quietest moment
 * near where each song should start; without them, for the quiet stretches themselves.
 * The envelope is the recording's loudness, ENV_RATE points a second (src-tauri/vinyl).
 */

export const ENV_RATE = 10;

export interface Splits {
  /** Where the music starts and ends (seconds). */
  start: number;
  end: number;
  /** Where songs 2, 3… start (seconds). */
  cuts: number[];
  /** For each cut: true when it wasn't clearly quiet there, or was far from where it was expected. */
  unsure: boolean[];
}

/** The loudness under which the record is "quiet": a little above its own surface noise. */
export function quietLevel(env: number[]): number {
  if (!env.length) return 0.012;
  const sorted = [...env].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const loud = sorted[Math.floor(sorted.length * 0.6)] ?? 0;
  return Math.max(0.006, Math.min(floor * 2.5 + 0.004, loud * 0.25));
}

/** Loudness averaged over `w` points either side, so a single click doesn't look like music. */
function smooth(env: number[], w = 3): number[] {
  const out = new Array<number>(env.length);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < env.length + w; i++) {
    if (i < env.length) { sum += env[i]; n++; }
    if (i - 2 * w - 1 >= 0) { sum -= env[i - 2 * w - 1]; n--; }
    const c = i - w;
    if (c >= 0 && c < env.length) out[c] = sum / n;
  }
  return out;
}

/** The first and last moments of music (a second of it in a row), in points. */
function musicSpan(s: number[], quiet: number): [number, number] {
  const run = ENV_RATE;
  let first = 0;
  for (let i = 0, k = 0; i < s.length; i++) {
    k = s[i] > quiet ? k + 1 : 0;
    if (k >= run) { first = i - run + 1; break; }
  }
  let last = s.length - 1;
  for (let i = s.length - 1, k = 0; i >= 0; i--) {
    k = s[i] > quiet ? k + 1 : 0;
    if (k >= run) { last = i + run - 1; break; }
  }
  return [Math.max(0, first - 2), Math.min(s.length - 1, Math.max(first, last) + 5)];
}

/**
 * Where the songs are. `lengths`: each song's length in seconds from MusicBrainz (null when it
 * doesn't know); leave it out to go by the quiet gaps alone.
 */
export function findSplits(env: number[], lengths?: (number | null | undefined)[]): Splits {
  const s = smooth(env);
  const quiet = quietLevel(s);
  const [a, b] = musicSpan(s, quiet);
  const start = a / ENV_RATE;
  const end = (b + 1) / ENV_RATE;
  const known = lengths && lengths.length > 1 && lengths.every((x) => typeof x === "number" && x > 0) ? (lengths as number[]) : null;

  if (known) {
    // Records can play a touch fast or slow: stretch the expected times to the music's real length
    // (only a little: a big difference means a song's length is off, not the speed).
    const total = known.reduce((x, y) => x + y, 0);
    const scale = total > 0 ? Math.min(1.01, Math.max(0.99, (end - start) / total)) : 1;
    const cuts: number[] = [];
    const unsure: boolean[] = [];
    let prev = a;
    for (let k = 0; k < known.length - 1; k++) {
      // Each song from where the last one was found to start, so one wrong length doesn't throw off the rest.
      const want = Math.round(prev + known[k] * scale * ENV_RATE);
      const lo = Math.max(prev + 10 * ENV_RATE, want - 25 * ENV_RATE);
      const hi = Math.min(b - 10 * ENV_RATE, want + 25 * ENV_RATE);
      let best = Math.min(Math.max(want, lo), Math.max(lo, hi));
      let bestScore = Infinity;
      for (let i = lo; i <= hi; i++) {
        // The quietest point, nudged toward where the song should start.
        const score = s[i] + Math.abs(i - want) * (quiet / (60 * ENV_RATE));
        if (score < bestScore) { bestScore = score; best = i; }
      }
      cuts.push(best / ENV_RATE);
      unsure.push(!(s[best] <= quiet) || Math.abs(best - want) > 15 * ENV_RATE);
      prev = best;
    }
    return { start, end, cuts, unsure };
  }

  // No lengths: every quiet stretch of a second or more (not at the very start or end) is a gap.
  const cuts: number[] = [];
  let runStart = -1;
  for (let i = a + 10 * ENV_RATE; i <= b - 10 * ENV_RATE; i++) {
    if (s[i] <= quiet) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= ENV_RATE) {
        const mid = Math.round((runStart + i) / 2);
        if (!cuts.length || mid - cuts[cuts.length - 1] * ENV_RATE >= 20 * ENV_RATE) cuts.push(mid / ENV_RATE);
      }
      runStart = -1;
    }
  }
  return { start, end, cuts, unsure: cuts.map(() => false) };
}

/** "3:51" */
export const clock = (sec: number) => {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

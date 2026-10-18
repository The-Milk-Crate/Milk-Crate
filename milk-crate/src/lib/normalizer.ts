/**
 * Measures songs for the Normalizer (see loudness.ts) and remembers the
 * results on this computer, so each song is only measured once.
 *
 * A song is measured the first time it plays with the Normalizer on, and the
 * next song in the queue is measured ahead of time so it starts at the right
 * level. Measuring downloads and decodes the whole song, one at a time.
 */
import { playableSrc } from "./localFiles";
import { MEASURE_RATE, type Loudness } from "./loudness";
import { load, save } from "./storage";
import type { Track } from "./types";

const CACHE_KEY = "mc.loudness";
const CACHE_LIMIT = 3000;

type Cache = Record<string, Loudness & { at: number }>;

export function cachedLoudness(): Record<string, Loudness> {
  return load<Cache>(CACHE_KEY, {});
}

function remember(id: string, l: Loudness) {
  const cache = load<Cache>(CACHE_KEY, {});
  cache[id] = { ...l, at: Date.now() };
  const ids = Object.keys(cache);
  if (ids.length > CACHE_LIMIT) {
    ids.sort((a, b) => cache[a].at - cache[b].at).slice(0, ids.length - CACHE_LIMIT).forEach((k) => delete cache[k]);
  }
  save(CACHE_KEY, cache);
}

const inFlight = new Map<string, Promise<Loudness | null>>();
let line: Promise<unknown> = Promise.resolve();

/** Measures a song (one at a time). Resolves null if it can't be read. */
export function measureTrack(track: Track): Promise<Loudness | null> {
  if (!track.src) return Promise.resolve(null);
  const pending = inFlight.get(track.id);
  if (pending) return pending;
  const job = line.then(async () => measure((await playableSrc(track)) ?? track.src!)).then((l) => {
    if (l) remember(track.id, l);
    return l;
  });
  line = job.catch(() => null);
  inFlight.set(track.id, job);
  void job.finally(() => inFlight.delete(track.id));
  return job;
}

async function measure(src: string): Promise<Loudness | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const ctx = new OfflineAudioContext(2, 1, MEASURE_RATE);
    const audio = await ctx.decodeAudioData(await res.arrayBuffer());
    const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, c) => audio.getChannelData(c).slice());
    return await new Promise<Loudness | null>((resolve) => {
      const worker = new Worker(new URL("./loudness.worker.ts", import.meta.url), { type: "module" });
      const done = (l: Loudness | null) => { worker.terminate(); resolve(l); };
      worker.onmessage = (e) => done(e.data.ok ? e.data.loudness : null);
      worker.onerror = () => done(null);
      worker.postMessage({ channels }, channels.map((c) => c.buffer));
    });
  } catch {
    return null;
  }
}

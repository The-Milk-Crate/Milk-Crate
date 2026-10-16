/// <reference lib="webworker" />
// Measures a track's sound off the main thread.
import { analyzeSamples } from "./sound";

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    self.postMessage({ ok: true, profile: analyzeSamples(e.data.samples, e.data.sampleRate) });
  } catch (err) {
    self.postMessage({ ok: false, message: (err as Error).message });
  }
};

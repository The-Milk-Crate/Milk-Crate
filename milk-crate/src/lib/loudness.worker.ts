/// <reference lib="webworker" />
// Measures a song's loudness off the main thread (see loudness.ts).
import { measureLoudness } from "./loudness";

self.onmessage = (e: MessageEvent<{ channels: Float32Array[] }>) => {
  try {
    self.postMessage({ ok: true, loudness: measureLoudness(e.data.channels) });
  } catch (err) {
    self.postMessage({ ok: false, message: (err as Error).message });
  }
};
